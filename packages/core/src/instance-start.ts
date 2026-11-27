import type { DatabaseWaitOutcome } from "./database-wait.ts";
import { type EventRegistry, registerEvents } from "./event-registry.ts";
import { describeThrown } from "./failure-reason.ts";
import type { RunningPlugins } from "./kernel.ts";
import type { Logger } from "./logger.ts";
import {
	type OperationRegistry,
	registerOperations,
} from "./operation-registry.ts";
import type { CoreSchemaMigration } from "./schema-migrations.ts";
import type { StartupStatus } from "./server.ts";

export type StartedPlugins = Pick<
	RunningPlugins,
	"failures" | "operations" | "events" | "deactivate"
>;

export type InstanceStartSteps = {
	readonly waitForDatabase: (
		stopSignal: AbortSignal,
	) => Promise<DatabaseWaitOutcome>;
	readonly migrateCoreSchema: (
		stopSignal: AbortSignal,
	) => Promise<CoreSchemaMigration>;
	readonly startPlugins: (stopSignal: AbortSignal) => Promise<StartedPlugins>;
};

export type InstanceStart = {
	status(): StartupStatus;
	readonly operations: OperationRegistry;
	readonly events: EventRegistry;
	run(): Promise<StartedPlugins>;
	stop(): void;
};

type StartFailure = "core_schema_not_migrated" | "plugin_schema_not_migrated";

const NO_PLUGINS: StartedPlugins = {
	failures: [],
	operations: registerOperations([]),
	events: registerEvents([]),
	deactivate: async () => "clean",
};

export function createInstanceStart(
	steps: InstanceStartSteps,
	logger: Logger,
): InstanceStart {
	const stopping = new AbortController();
	let status: StartupStatus = "starting";
	let operations = NO_PLUGINS.operations;
	let events = NO_PLUGINS.events;
	let running: Promise<StartedPlugins> | undefined;

	const fail = (
		reason: StartFailure,
		details: Record<string, unknown> = {},
	): StartedPlugins => {
		status = "failed";
		logger.error("instance failed to start", { reason, ...details });
		return NO_PLUGINS;
	};

	const start = async (): Promise<StartedPlugins> => {
		const { signal } = stopping;
		if ((await steps.waitForDatabase(signal)) === "stopped") return NO_PLUGINS;
		let coreSchema: CoreSchemaMigration;
		try {
			coreSchema = await steps.migrateCoreSchema(signal);
		} catch (error) {
			return fail("core_schema_not_migrated", { error: describeThrown(error) });
		}
		if (coreSchema === "stopped") return NO_PLUGINS;
		if (coreSchema === "not_migrated") return fail("core_schema_not_migrated");
		const plugins = await steps.startPlugins(signal);
		operations = plugins.operations;
		events = plugins.events;
		const unmigrated = plugins.failures
			.filter((failure) => failure.reason === "migration_failed")
			.map((failure) => failure.plugin);
		if (unmigrated.length > 0) {
			fail("plugin_schema_not_migrated", { plugins: unmigrated });
		} else if (!signal.aborted) {
			status = "started";
			logger.info("instance started");
		}
		return plugins;
	};

	return {
		status: () => status,
		operations: { find: (name) => operations.find(name) },
		events: {
			findEvent: (name) => events.findEvent(name),
			subscriptions: () => events.subscriptions(),
		},
		run: () => {
			running ??= start().catch((error: unknown) => {
				status = "failed";
				throw error;
			});
			return running;
		},
		stop: () => stopping.abort(),
	};
}
