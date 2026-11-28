import { describe, expect, test } from "bun:test";
import type { DatabaseWaitOutcome } from "./database-wait.ts";
import {
	type RegisteredEvent,
	type RegisteredSubscription,
	registerEvents,
} from "./event-registry.ts";
import {
	createInstanceStart,
	type InstanceStartSteps,
	type StartedPlugins,
} from "./instance-start.ts";
import { type RegisteredJob, registerJobs } from "./job-registry.ts";
import type { LoadFailure } from "./kernel.ts";
import {
	type RegisteredOperation,
	registerOperations,
} from "./operation-registry.ts";
import { pluginOwner } from "./owner.ts";
import type { CoreSchemaMigration } from "./schema-migrations.ts";
import { type LogEntry, recordingLogger } from "./testing/recording-logger.ts";

function pluginsWith(...failures: LoadFailure[]): StartedPlugins {
	return {
		failures,
		operations: registerOperations([]),
		events: registerEvents({ active: [], notActive: [] }),
		jobs: registerJobs([]),
		deactivate: async () => "clean",
	};
}

const MIGRATION_FAILED: LoadFailure = {
	plugin: "notes",
	reason: "migration_failed",
	detail:
		'plugin "notes" was not activated because its schema could not be migrated: boom',
};

function steps(
	overrides: Partial<InstanceStartSteps> = {},
): InstanceStartSteps {
	return {
		waitForDatabase: async (): Promise<DatabaseWaitOutcome> => "reachable",
		migrateCoreSchema: async (): Promise<CoreSchemaMigration> => "migrated",
		startPlugins: async () => pluginsWith(),
		...overrides,
	};
}

function pendingStep<Outcome>() {
	const called = Promise.withResolvers<void>();
	const outcome = Promise.withResolvers<Outcome>();
	return {
		called: called.promise,
		run: (): Promise<Outcome> => {
			called.resolve();
			return outcome.promise;
		},
		finish: (value: Outcome) => outcome.resolve(value),
	};
}

describe("instance start", () => {
	test("runs each step only once the previous one is done, is starting meanwhile and started after the last", async () => {
		const called: string[] = [];
		const observed: { called: string[]; status: string }[] = [];
		const databaseWait = pendingStep<DatabaseWaitOutcome>();
		const coreMigration = pendingStep<CoreSchemaMigration>();
		const pluginStart = pendingStep<StartedPlugins>();
		const { logger, entries } = recordingLogger();
		const instance = createInstanceStart(
			{
				waitForDatabase: () => {
					called.push("wait for database");
					return databaseWait.run();
				},
				migrateCoreSchema: () => {
					called.push("migrate core");
					return coreMigration.run();
				},
				startPlugins: () => {
					called.push("start plugins");
					return pluginStart.run();
				},
			},
			logger,
		);
		const observe = () =>
			observed.push({ called: [...called], status: instance.status() });

		const running = instance.run();
		await databaseWait.called;
		observe();
		databaseWait.finish("reachable");
		await coreMigration.called;
		observe();
		coreMigration.finish("migrated");
		await pluginStart.called;
		observe();
		pluginStart.finish(pluginsWith());
		await running;

		expect(observed).toEqual([
			{ called: ["wait for database"], status: "starting" },
			{ called: ["wait for database", "migrate core"], status: "starting" },
			{
				called: ["wait for database", "migrate core", "start plugins"],
				status: "starting",
			},
		]);
		expect(instance.status()).toBe("started");
		expect(entries).toContainEqual(
			expect.objectContaining({ level: "info", message: "instance started" }),
		);
	});

	test.each<[string, Partial<InstanceStartSteps>, LogEntry]>([
		[
			"a core migration fails",
			{ migrateCoreSchema: async () => "not_migrated" },
			{ reason: "core_schema_not_migrated" },
		],
		[
			"the core migration cannot run",
			{
				migrateCoreSchema: () =>
					Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
			},
			{
				reason: "core_schema_not_migrated",
				error: expect.objectContaining({
					message: "connect ECONNREFUSED 127.0.0.1:5432",
				}),
			},
		],
		[
			"the schema of a plugin is not migrated",
			{ startPlugins: async () => pluginsWith(MIGRATION_FAILED) },
			{ reason: "plugin_schema_not_migrated", plugins: ["notes"] },
		],
	])("has failed and says why when %s", async (_, failing, logged) => {
		const { logger, entries } = recordingLogger();
		const instance = createInstanceStart(steps(failing), logger);

		await instance.run();

		expect(instance.status()).toBe("failed");
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "instance failed to start",
				...logged,
			}),
		);
	});

	test("starts no plugin when the core schema is not migrated", async () => {
		let started = false;
		const instance = createInstanceStart(
			steps({
				migrateCoreSchema: async () => "not_migrated",
				startPlugins: async () => {
					started = true;
					return pluginsWith();
				},
			}),
			recordingLogger().logger,
		);

		await instance.run();

		expect(started).toBe(false);
	});

	test("has no core schema while it is being migrated or when it is not migrated", async () => {
		const migrating = createInstanceStart(
			steps({ migrateCoreSchema: () => new Promise(() => {}) }),
			recordingLogger().logger,
		);
		const notMigrated = createInstanceStart(
			steps({ migrateCoreSchema: async () => "not_migrated" }),
			recordingLogger().logger,
		);

		void migrating.run();
		await notMigrated.run();

		expect(migrating.hasCoreSchema()).toBe(false);
		expect(notMigrated.hasCoreSchema()).toBe(false);
	});

	test("has the core schema once it is migrated, while the plugins are still starting", async () => {
		const pluginsStarting = Promise.withResolvers<void>();
		const instance = createInstanceStart(
			steps({
				startPlugins: () => {
					pluginsStarting.resolve();
					return new Promise(() => {});
				},
			}),
			recordingLogger().logger,
		);

		void instance.run();
		await pluginsStarting.promise;

		expect(instance.hasCoreSchema()).toBe(true);
	});

	test("has failed when a step throws unexpectedly, and passes the error on", async () => {
		const instance = createInstanceStart(
			steps({ startPlugins: () => Promise.reject(new Error("disk on fire")) }),
			recordingLogger().logger,
		);

		const run = instance.run();

		await expect(run).rejects.toThrow("disk on fire");
		expect(instance.status()).toBe("failed");
	});

	test("hands each step the signal that stop raises, and stays starting once stopped", async () => {
		const signals: AbortSignal[] = [];
		const { logger, entries } = recordingLogger();
		const instance = createInstanceStart(
			{
				waitForDatabase: async (stopSignal) => {
					signals.push(stopSignal);
					return "reachable";
				},
				migrateCoreSchema: async (stopSignal) => {
					signals.push(stopSignal);
					return "migrated";
				},
				startPlugins: async (stopSignal) => {
					signals.push(stopSignal);
					instance.stop();
					return pluginsWith();
				},
			},
			logger,
		);

		await instance.run();

		expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true]);
		expect(instance.status()).toBe("starting");
		expect(entries.map((entry) => entry.message)).not.toContain(
			"instance started",
		);
	});

	test.each<[string, Partial<InstanceStartSteps>]>([
		["waiting for the database", { waitForDatabase: async () => "stopped" }],
		["migrating the core schema", { migrateCoreSchema: async () => "stopped" }],
	])("starts no plugin when it is stopped while %s", async (_, stopping) => {
		let started = false;
		const instance = createInstanceStart(
			steps({
				...stopping,
				startPlugins: async () => {
					started = true;
					return pluginsWith();
				},
			}),
			recordingLogger().logger,
		);

		const plugins = await instance.run();

		expect(started).toBe(false);
		expect(await plugins.deactivate()).toBe("clean");
		expect(instance.status()).toBe("starting");
	});
});

describe("operations of an instance", () => {
	const renameLabel: RegisteredOperation = {
		name: "board.renameLabel",
		owner: { kind: "plugin", name: "board" },
		kind: "mutation",
		target: "workspace",
		right: "board.label.edit",
		validateInput: async (value) => ({ valid: true, value }),
		validateOutput: async (value) => ({ valid: true, value }),
		describeInput: () => ({}),
		describeOutput: () => ({}),
		execute: async () => ({}),
	};

	test("are none while the plugins are still starting", () => {
		const instance = createInstanceStart(
			steps({ startPlugins: () => new Promise(() => {}) }),
			recordingLogger().logger,
		);

		void instance.run();

		expect(instance.operations.find("board.renameLabel")).toBeUndefined();
	});

	test("are those of the started plugins once they started", async () => {
		const instance = createInstanceStart(
			steps({
				startPlugins: async () => ({
					...pluginsWith(),
					operations: registerOperations([renameLabel]),
				}),
			}),
			recordingLogger().logger,
		);

		await instance.run();

		expect(instance.operations.find("board.renameLabel")).toBe(renameLabel);
	});
});

describe("events of an instance", () => {
	const labelRenamed: RegisteredEvent = {
		name: "board.LabelRenamed",
		version: 1,
		validatePayload: async (value) => ({ valid: true, value }),
	};
	const indexLabel: RegisteredSubscription = {
		subscriber: "search",
		event: labelRenamed.name,
		validatePayload: labelRenamed.validatePayload,
		handle: async () => {},
	};

	test("are none while the plugins are still starting", () => {
		const instance = createInstanceStart(
			steps({ startPlugins: () => new Promise(() => {}) }),
			recordingLogger().logger,
		);

		void instance.run();

		expect(instance.events.findEvent("board.LabelRenamed")).toBeUndefined();
		expect(instance.events.subscriptions()).toEqual([]);
	});

	test("are those of the started plugins once they started, with their subscriptions", async () => {
		const instance = createInstanceStart(
			steps({
				startPlugins: async () => ({
					...pluginsWith(),
					events: registerEvents({
						active: [{ events: [labelRenamed], subscriptions: [indexLabel] }],
						notActive: [],
					}),
				}),
			}),
			recordingLogger().logger,
		);

		await instance.run();

		expect(instance.events.findEvent("board.LabelRenamed")).toBe(labelRenamed);
		expect(instance.events.subscriptions()).toEqual([indexLabel]);
	});
});

describe("jobs of an instance", () => {
	const archiveLabels: RegisteredJob = {
		kind: "enqueued",
		owner: pluginOwner("board"),
		name: "board.archiveLabels",
		maxAttempts: 3,
		validatePayload: async (value) => ({ valid: true, value }),
		run: async () => {},
	};

	test("are none while the plugins are still starting", () => {
		const instance = createInstanceStart(
			steps({ startPlugins: () => new Promise(() => {}) }),
			recordingLogger().logger,
		);

		void instance.run();

		expect(instance.jobs.find("board.archiveLabels")).toBeUndefined();
		expect(instance.jobs.names()).toEqual([]);
	});

	test("are those of the started plugins once they started", async () => {
		const instance = createInstanceStart(
			steps({
				startPlugins: async () => ({
					...pluginsWith(),
					jobs: registerJobs([archiveLabels]),
				}),
			}),
			recordingLogger().logger,
		);

		await instance.run();

		expect(instance.jobs.find("board.archiveLabels")).toBe(archiveLabels);
		expect(instance.jobs.names()).toEqual(["board.archiveLabels"]);
	});
});
