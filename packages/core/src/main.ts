import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { authenticateToken } from "./api-tokens.ts";
import {
	type Config,
	InvalidConfigError,
	loadConfigFromEnvironment,
} from "./config.ts";
import { fullJitterBackoff, untilDatabaseReachable } from "./database-wait.ts";
import { startEventDeliveryLoop } from "./event-delivery-loop.ts";
import { createEventDelivery } from "./event-outbox.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { createInstanceStart } from "./instance-start.ts";
import { startJobLoop } from "./job-loop.ts";
import { createJobQueue } from "./job-queue.ts";
import { startPlugins } from "./kernel.ts";
import { createLogger } from "./logger.ts";
import { createOperationPipeline } from "./operation-pipeline.ts";
import { discoverPluginPackages } from "./plugin-discovery.ts";
import { createPostgresCheck } from "./postgres.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "./schema-migrations.ts";
import {
	type RunningServer,
	type ServerOptions,
	startServer,
} from "./server.ts";
import { reportFailedStart, shutDownInstance } from "./shutdown.ts";
import { systemFailureReason } from "./system-error.ts";

const PACKAGES_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

const CLOSED_PIPE = "EPIPE";

const DATABASE_RETRY = { baseMs: 250, capMs: 10_000 } as const;

const MIGRATION_CONNECTION_TIMEOUT_MS = 10_000;

const MIGRATION_STATEMENT_TIMEOUT_MS = 60_000;

const OPERATION_CONNECTION_TIMEOUT_S = 10;

const OPERATION_STATEMENT_TIMEOUT_MS = 60_000;

const DATABASE_CLOSE_TIMEOUT_S = 5;

const MIGRATION_LOCK_RETRY = { baseMs: 250, capMs: 2_000 } as const;

const EVENT_DELIVERY_POLL_INTERVAL_MS = 1_000;

const JOB_QUEUE_POLL_INTERVAL_MS = 1_000;

const now = (): Date => new Date();

process.stdout.on("error", (error) => {
	if (systemFailureReason(error) !== CLOSED_PIPE) throw error;
});

function loadConfigOrExit(): Config {
	try {
		return loadConfigFromEnvironment();
	} catch (error) {
		if (!(error instanceof InvalidConfigError)) throw error;
		const logger = createLogger({
			level: "error",
			now,
			write: (line) => process.stderr.write(`${line}\n`),
		});
		logger.error("invalid configuration, not starting", {
			issues: error.issues,
		});
		process.exit(1);
	}
}

function startServerOrExit(options: ServerOptions): RunningServer {
	try {
		return startServer(options);
	} catch (error) {
		options.logger.error("server failed to start", {
			port: options.port,
			reason: systemFailureReason(error),
		});
		process.exit(1);
	}
}

const config = loadConfigOrExit();
const logger = createLogger({
	level: config.logLevel,
	now,
	write: (line) => process.stdout.write(`${line}\n`),
});
const checkDatabase = createPostgresCheck({
	url: config.databaseUrl,
	timeoutMs: config.readinessTimeoutMs,
});
const migrationRunner: MigrationRunner = {
	databaseUrl: config.databaseUrl,
	connectionTimeoutMs: MIGRATION_CONNECTION_TIMEOUT_MS,
	statementTimeoutMs: MIGRATION_STATEMENT_TIMEOUT_MS,
	lockRetryDelayMs: fullJitterBackoff({
		...MIGRATION_LOCK_RETRY,
		random: Math.random,
	}),
	setTimer: setSystemTimer,
	logger,
};
const instance = createInstanceStart(
	{
		waitForDatabase: (stopSignal) =>
			untilDatabaseReachable({
				check: checkDatabase,
				retryDelayMs: fullJitterBackoff({
					...DATABASE_RETRY,
					random: Math.random,
				}),
				setTimer: setSystemTimer,
				stopSignal,
				logger,
			}),
		migrateCoreSchema: (stopSignal) =>
			migrateCoreSchema(migrationRunner, CORE_MIGRATIONS_DIRECTORY, stopSignal),
		startPlugins: (stopSignal) =>
			startPlugins({
				discover: discoverPluginPackages(PACKAGES_DIRECTORY),
				enabledPlugins: config.enabledPlugins,
				capabilityProviders: {},
				migrateSchemas: (schemas) =>
					migrateSchemas(migrationRunner, schemas, stopSignal),
				hookTimeout: {
					ms: config.pluginHookTimeoutMs,
					setTimer: setSystemTimer,
				},
				stopSignal,
				logger,
			}),
	},
	logger,
);
const sql = new SQL(config.databaseUrl.reveal(), {
	connectionTimeout: OPERATION_CONNECTION_TIMEOUT_S,
	connection: { statement_timeout: OPERATION_STATEMENT_TIMEOUT_MS },
});
const eventDelivery = startEventDeliveryLoop({
	delivery: createEventDelivery({
		sql,
		events: instance.events,
		now,
		newId: () => crypto.randomUUID(),
		random: Math.random,
		handlerTimeout: {
			ms: config.pluginHookTimeoutMs,
			setTimer: setSystemTimer,
		},
		logger,
	}),
	pollIntervalMs: EVENT_DELIVERY_POLL_INTERVAL_MS,
	setTimer: setSystemTimer,
	logger,
});
const jobQueue = startJobLoop({
	queue: createJobQueue({
		sql,
		jobs: instance.jobs,
		now,
		newId: () => crypto.randomUUID(),
		newJobId: () => crypto.randomUUID(),
		random: Math.random,
		runTimeout: {
			ms: config.pluginHookTimeoutMs,
			setTimer: setSystemTimer,
		},
		logger,
	}),
	pollIntervalMs: JOB_QUEUE_POLL_INTERVAL_MS,
	setTimer: setSystemTimer,
	logger,
});
const server = startServerOrExit({
	port: config.port,
	logger,
	checkDatabase,
	newCorrelationId: () => crypto.randomUUID(),
	startupStatus: instance.status,
	api: {
		authenticate: (token) => authenticateToken(sql, token, now()),
		pipeline: createOperationPipeline({
			sql,
			registry: instance.operations,
			events: instance.events,
			now,
			newId: () => crypto.randomUUID(),
			newAuditEntryId: () => crypto.randomUUID(),
			newEventId: () => crypto.randomUUID(),
			eventsCommitted: eventDelivery.wake,
			jobs: instance.jobs,
			newJobId: () => crypto.randomUUID(),
			jobsCommitted: jobQueue.wake,
			random: Math.random,
			logger,
		}),
	},
});
logger.info("server started", { port: server.port });

const plugins = reportFailedStart(instance.run(), logger);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		logger.info("shutting down", { signal });
		void shutDownInstance(
			{
				stopStartingPlugins: instance.stop,
				server,
				eventDelivery,
				jobQueue,
				plugins,
				database: {
					close: () => sql.close({ timeout: DATABASE_CLOSE_TIMEOUT_S }),
				},
			},
			logger,
		).then((exitCode) => process.exit(exitCode));
	});
}
