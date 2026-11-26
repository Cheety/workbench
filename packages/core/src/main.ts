import { fileURLToPath } from "node:url";
import {
	type Config,
	InvalidConfigError,
	loadConfigFromEnvironment,
} from "./config.ts";
import { fullJitterBackoff, untilDatabaseReachable } from "./database-wait.ts";
import { describeThrown } from "./failure-reason.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { type RunningPlugins, startPlugins } from "./kernel.ts";
import { createLogger } from "./logger.ts";
import { discoverPluginPackages } from "./plugin-discovery.ts";
import { createPostgresCheck } from "./postgres.ts";
import { type MigrationRunner, migrateSchemas } from "./schema-migrations.ts";
import {
	type RunningServer,
	type ServerOptions,
	type StartupStatus,
	startServer,
} from "./server.ts";
import { reportFailedStart, shutDownInstance } from "./shutdown.ts";
import { systemFailureReason } from "./system-error.ts";

const PACKAGES_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

const CLOSED_PIPE = "EPIPE";

const DATABASE_RETRY = { baseMs: 250, capMs: 10_000 } as const;

const MIGRATION_CONNECTION_TIMEOUT_MS = 10_000;

const MIGRATION_LOCK_RETRY = { baseMs: 250, capMs: 2_000 } as const;

type StartedPlugins = Pick<RunningPlugins, "deactivate">;

const NO_PLUGINS: StartedPlugins = { deactivate: async () => "clean" };

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
let startupStatus: StartupStatus = "starting";
const checkDatabase = createPostgresCheck({
	url: config.databaseUrl,
	timeoutMs: config.readinessTimeoutMs,
});
const server = startServerOrExit({
	port: config.port,
	logger,
	checkDatabase,
	newCorrelationId: () => crypto.randomUUID(),
	startupStatus: () => startupStatus,
});
logger.info("server started", { port: server.port });

const instanceStart = new AbortController();

const migrationRunner: MigrationRunner = {
	databaseUrl: config.databaseUrl,
	connectionTimeoutMs: MIGRATION_CONNECTION_TIMEOUT_MS,
	lockRetryDelayMs: fullJitterBackoff({
		...MIGRATION_LOCK_RETRY,
		random: Math.random,
	}),
	setTimer: setSystemTimer,
	logger,
};

type StartFailure = "core_schema_not_migrated" | "plugin_schema_not_migrated";

function failStart(
	reason: StartFailure,
	details: Record<string, unknown> = {},
): void {
	startupStatus = "failed";
	logger.error("instance failed to start", { reason, ...details });
}

async function startInstance(): Promise<StartedPlugins> {
	const database = await untilDatabaseReachable({
		check: checkDatabase,
		retryDelayMs: fullJitterBackoff({ ...DATABASE_RETRY, random: Math.random }),
		setTimer: setSystemTimer,
		stopSignal: instanceStart.signal,
		logger,
	});
	if (database === "stopped") return NO_PLUGINS;
	try {
		await migrateSchemas(migrationRunner, [], instanceStart.signal);
	} catch (error) {
		failStart("core_schema_not_migrated", { error: describeThrown(error) });
		return NO_PLUGINS;
	}
	const plugins = await startPlugins({
		discover: discoverPluginPackages(PACKAGES_DIRECTORY),
		enabledPlugins: config.enabledPlugins,
		capabilityProviders: {},
		migrateSchemas: (schemas) =>
			migrateSchemas(migrationRunner, schemas, instanceStart.signal),
		hookTimeout: { ms: config.pluginHookTimeoutMs, setTimer: setSystemTimer },
		stopSignal: instanceStart.signal,
		logger,
	});
	const unmigrated = plugins.failures
		.filter((failure) => failure.reason === "migration_failed")
		.map((failure) => failure.plugin);
	if (unmigrated.length > 0) {
		failStart("plugin_schema_not_migrated", { plugins: unmigrated });
	} else if (!instanceStart.signal.aborted) {
		startupStatus = "started";
		logger.info("instance started");
	}
	return plugins;
}

const plugins = reportFailedStart(
	startInstance().catch((error: unknown) => {
		startupStatus = "failed";
		throw error;
	}),
	logger,
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		logger.info("shutting down", { signal });
		void shutDownInstance(
			{ stopStartingPlugins: () => instanceStart.abort(), server, plugins },
			logger,
		).then((exitCode) => process.exit(exitCode));
	});
}
