import {
	type Config,
	InvalidConfigError,
	loadConfigFromEnvironment,
} from "./config.ts";
import { createLogger } from "./logger.ts";
import { createPostgresCheck } from "./postgres.ts";
import {
	type RunningServer,
	type ServerOptions,
	startServer,
} from "./server.ts";

const now = (): Date => new Date();

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

const UNKNOWN_START_FAILURE = "unknown";

function startServerOrExit(options: ServerOptions): RunningServer {
	try {
		return startServer(options);
	} catch (error) {
		options.logger.error("server failed to start", {
			port: options.port,
			reason: systemErrorCode(error) ?? UNKNOWN_START_FAILURE,
		});
		process.exit(1);
	}
}

function systemErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

const config = loadConfigOrExit();
const logger = createLogger({
	level: config.logLevel,
	now,
	write: (line) => process.stdout.write(`${line}\n`),
});
const server = startServerOrExit({
	port: config.port,
	logger,
	checkDatabase: createPostgresCheck({
		url: config.databaseUrl,
		timeoutMs: config.readinessTimeoutMs,
		logger,
	}),
	newCorrelationId: () => crypto.randomUUID(),
});
logger.info("server started", { port: server.port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		logger.info("shutting down", { signal });
		void server.stop().then(() => process.exit(0));
	});
}
