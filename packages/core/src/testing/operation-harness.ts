import type { Actor } from "@workbench/sdk";
import { Secret } from "../config.ts";
import { createEventDelivery } from "../event-outbox.ts";
import { setSystemTimer } from "../hook-timeout.ts";
import {
	type PluginPackage,
	type RunningPlugins,
	startPlugins,
} from "../kernel.ts";
import type { Logger } from "../logger.ts";
import {
	createOperationPipeline,
	type OperationPipeline,
	type OperationResult,
} from "../operation-pipeline.ts";
import { readPluginPackage } from "../plugin-discovery.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "../schema-migrations.ts";
import { createWorkspace } from "../workspaces.ts";
import { createFreshDatabase, type FreshDatabase } from "./postgres.ts";
import { type LogEntry, recordingLogger } from "./recording-logger.ts";

export type { PluginPackage } from "../kernel.ts";
export type {
	FailureKind,
	OperationFailure,
	OperationResult,
} from "../operation-pipeline.ts";
export type { ValidationIssue } from "../schema-validation.ts";

export type OperationHarnessOptions = {
	readonly plugins: readonly PluginPackage[];
	readonly now?: () => Date;
	readonly newId?: () => string;
	readonly random?: () => number;
	readonly newCorrelationId?: () => string;
};

export type HarnessCall = {
	readonly actor: Actor;
	readonly workspace: string;
	readonly operation: string;
	readonly input: unknown;
};

export type OperationHarness = {
	readonly logEntries: readonly LogEntry[];
	createWorkspace(name: string): Promise<string>;
	call(call: HarnessCall): Promise<OperationResult>;
	deliverEvents(): Promise<void>;
	stop(): Promise<void>;
};

export class HarnessStartError extends Error {
	constructor(problem: string) {
		super(`the operation harness could not start: ${problem}`);
		this.name = "HarnessStartError";
	}
}

const FIXED_NOW = new Date("2026-11-26T08:00:00.000Z");

const FIXED_RANDOM = 0.5;

const OPERATION_ID_GROUP = "8000";

const AUDIT_ENTRY_ID_GROUP = "a000";

const EVENT_ID_GROUP = "e000";

const NOT_STOPPED = new AbortController().signal;

const HOOK_TIMEOUT_MS = 10_000;

const CONNECTION_TIMEOUT_MS = 10_000;

const STATEMENT_TIMEOUT_MS = 60_000;

export async function pluginPackageAt(
	directory: string,
): Promise<PluginPackage> {
	const { packages, unreadable } = await readPluginPackage(directory);
	const [found] = packages;
	if (found !== undefined) return found;
	throw new HarnessStartError(
		unreadable[0]?.problem ?? `${directory} contains no plugin package`,
	);
}

export async function startOperationHarness(
	options: OperationHarnessOptions,
): Promise<OperationHarness> {
	const { logger, entries } = recordingLogger();
	const database = await createFreshDatabase();
	try {
		const runner: MigrationRunner = {
			databaseUrl: new Secret(database.url),
			connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
			statementTimeoutMs: STATEMENT_TIMEOUT_MS,
			lockRetryDelayMs: () => 0,
			setTimer: setSystemTimer,
			logger,
		};
		const core = await migrateCoreSchema(
			runner,
			CORE_MIGRATIONS_DIRECTORY,
			NOT_STOPPED,
		);
		if (core !== "migrated")
			throw new HarnessStartError("the core schema was not migrated");
		const plugins = await startPlugins({
			discover: async () => ({ packages: options.plugins, unreadable: [] }),
			enabledPlugins: options.plugins.map((plugin) => plugin.pluginName),
			capabilityProviders: {},
			migrateSchemas: (schemas) => migrateSchemas(runner, schemas, NOT_STOPPED),
			hookTimeout: { ms: HOOK_TIMEOUT_MS, setTimer: setSystemTimer },
			logger,
		});
		const [failure] = plugins.failures;
		if (failure !== undefined) {
			await plugins.deactivate();
			throw new HarnessStartError(failure.detail);
		}
		return harnessOf(database, plugins, options, { logger, entries });
	} catch (error) {
		await database.drop();
		throw error;
	}
}

function harnessOf(
	database: FreshDatabase,
	plugins: RunningPlugins,
	options: OperationHarnessOptions,
	{
		logger,
		entries,
	}: { readonly logger: Logger; readonly entries: readonly LogEntry[] },
): OperationHarness {
	const now = options.now ?? (() => FIXED_NOW);
	const newId = options.newId ?? sequentialIds(OPERATION_ID_GROUP);
	const random = options.random ?? (() => FIXED_RANDOM);
	const pipeline: OperationPipeline = createOperationPipeline({
		sql: database.sql,
		registry: plugins.operations,
		events: plugins.events,
		now,
		newId,
		newAuditEntryId: sequentialIds(AUDIT_ENTRY_ID_GROUP),
		newEventId: sequentialIds(EVENT_ID_GROUP),
		eventsCommitted: () => {},
		random,
		logger,
	});
	const delivery = createEventDelivery({
		sql: database.sql,
		events: plugins.events,
		now,
		newId,
		random,
		handlerTimeout: { ms: HOOK_TIMEOUT_MS, setTimer: setSystemTimer },
		logger,
	});
	const newCorrelationId =
		options.newCorrelationId ?? sequentialCorrelationIds();
	return {
		logEntries: entries,
		createWorkspace: async (name) => {
			const id = newId();
			await createWorkspace(database.sql, { id, name, createdAt: now() });
			return id;
		},
		call: (call) =>
			pipeline.invoke({
				...call,
				apiTokenId: null,
				correlationId: newCorrelationId(),
			}),
		deliverEvents: () => delivery.deliverDue(NOT_STOPPED),
		stop: async () => {
			try {
				await plugins.deactivate();
			} finally {
				await database.drop();
			}
		},
	};
}

function sequentialIds(group: string): () => string {
	let issued = 0;
	return () => {
		issued += 1;
		return `00000000-0000-4000-${group}-${String(issued).padStart(12, "0")}`;
	};
}

function sequentialCorrelationIds(): () => string {
	let issued = 0;
	return () => {
		issued += 1;
		return `harness-call-${issued}`;
	};
}
