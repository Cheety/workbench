import { describe, expect, test } from "bun:test";
import type { DatabaseWaitOutcome } from "./database-wait.ts";
import {
	createInstanceStart,
	type InstanceStartSteps,
	type StartedPlugins,
} from "./instance-start.ts";
import type { LoadFailure } from "./kernel.ts";
import type { CoreSchemaMigration } from "./schema-migrations.ts";
import { type LogEntry, recordingLogger } from "./testing/recording-logger.ts";

function pluginsWith(...failures: LoadFailure[]): StartedPlugins {
	return { failures, deactivate: async () => "clean" };
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

describe("instance start", () => {
	test("is starting while it waits for the database", () => {
		const instance = createInstanceStart(
			steps({ waitForDatabase: () => new Promise(() => {}) }),
			recordingLogger().logger,
		);

		void instance.run();

		expect(instance.status()).toBe("starting");
	});

	test("is started once the database is reachable, core is migrated and the plugins are started", async () => {
		const journal: string[] = [];
		const { logger, entries } = recordingLogger();
		const instance = createInstanceStart(
			{
				waitForDatabase: async () => {
					journal.push("wait for database");
					return "reachable";
				},
				migrateCoreSchema: async () => {
					journal.push("migrate core");
					return "migrated";
				},
				startPlugins: async () => {
					journal.push("start plugins");
					return pluginsWith();
				},
			},
			logger,
		);

		await instance.run();

		expect(instance.status()).toBe("started");
		expect(journal).toEqual([
			"wait for database",
			"migrate core",
			"start plugins",
		]);
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
