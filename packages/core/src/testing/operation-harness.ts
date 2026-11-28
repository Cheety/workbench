import type { Actor } from "@workbench/sdk";
import { Secret } from "../config.ts";
import { createEventDelivery } from "../event-outbox.ts";
import { setSystemTimer } from "../hook-timeout.ts";
import { isInstanceAdminOf } from "../instance-admins.ts";
import { createJobQueue } from "../job-queue.ts";
import {
	type PluginPackage,
	type RunningPlugins,
	startPlugins,
} from "../kernel.ts";
import type { Logger } from "../logger.ts";
import { grantMembership } from "../memberships.ts";
import {
	createOperationPipeline,
	type OperationPipeline,
	type OperationResult,
} from "../operation-pipeline.ts";
import { readPluginPackage } from "../plugin-discovery.ts";
import { roleName } from "../role-name.ts";
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
	readonly newAuditEntryId?: () => string;
	readonly random?: () => number;
	readonly newCorrelationId?: () => string;
	readonly instanceAdmins?: readonly Actor[];
};

export type HarnessMember = {
	readonly actor: Actor;
	readonly role: string;
};

export type HarnessCall = {
	readonly actor: Actor;
	readonly workspace: string | null;
	readonly operation: string;
	readonly input: unknown;
	readonly idempotencyKey?: string;
};

export type OperationHarness = {
	readonly logEntries: readonly LogEntry[];
	createWorkspace(
		name: string,
		members: readonly HarnessMember[],
	): Promise<string>;
	call(call: HarnessCall): Promise<OperationResult>;
	deliverEvents(): Promise<void>;
	runJobs(): Promise<void>;
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

const JOB_ID_GROUP = "b000";

const EVENT_HANDLER_ID_GROUP = "c000";

const JOB_RUN_ID_GROUP = "d000";

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
	const newJobId = sequentialIds(JOB_ID_GROUP);
	const pipeline: OperationPipeline = createOperationPipeline({
		sql: database.sql,
		registry: plugins.operations,
		events: plugins.events,
		now,
		newId,
		newAuditEntryId:
			options.newAuditEntryId ?? sequentialIds(AUDIT_ENTRY_ID_GROUP),
		newEventId: sequentialIds(EVENT_ID_GROUP),
		eventsCommitted: () => {},
		jobs: plugins.jobs,
		newJobId,
		jobsCommitted: () => {},
		random,
		newApiToken: sequentialTokens(),
		isInstanceAdmin: isInstanceAdminOf(options.instanceAdmins ?? []),
		logger,
	});
	const delivery = createEventDelivery({
		sql: database.sql,
		cancellation: database.cancellation,
		events: plugins.events,
		hasCoreSchema: () => true,
		now,
		newId: sequentialIds(EVENT_HANDLER_ID_GROUP),
		random,
		handlerTimeout: { ms: HOOK_TIMEOUT_MS, setTimer: setSystemTimer },
		logger,
	});
	const jobQueue = createJobQueue({
		sql: database.sql,
		cancellation: database.cancellation,
		jobs: plugins.jobs,
		hasCoreSchema: () => true,
		now,
		newId: sequentialIds(JOB_RUN_ID_GROUP),
		newJobId,
		random,
		runTimeout: { ms: HOOK_TIMEOUT_MS, setTimer: setSystemTimer },
		logger,
	});
	const newCorrelationId =
		options.newCorrelationId ?? sequentialCorrelationIds();
	return {
		logEntries: entries,
		createWorkspace: async (name, members) => {
			const id = newId();
			const createdAt = now();
			await database.sql.begin(async (transaction) => {
				await createWorkspace(transaction, { id, name, createdAt });
				for (const { actor, role } of members)
					await grantMembership(transaction, {
						workspace: id,
						actor,
						role: roleName(role),
						createdAt,
					});
			});
			return id;
		},
		call: ({ idempotencyKey, ...call }) =>
			pipeline.invoke({
				...call,
				apiToken: null,
				idempotencyKey: idempotencyKey ?? null,
				correlationId: newCorrelationId(),
			}),
		deliverEvents: () => delivery.deliverDue(NOT_STOPPED),
		runJobs: () => jobQueue.runDue(NOT_STOPPED),
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

function sequentialTokens(): () => Secret {
	let issued = 0;
	return () => {
		issued += 1;
		return new Secret(`wbt_harness-token-${issued}`);
	};
}

function sequentialCorrelationIds(): () => string {
	let issued = 0;
	return () => {
		issued += 1;
		return `harness-call-${issued}`;
	};
}
