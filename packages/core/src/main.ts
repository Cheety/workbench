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
import { shutDown } from "./shutdown.ts";
import { systemFailureReason } from "./system-error.ts";

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
		void shutDown(server, logger).then((exitCode) => process.exit(exitCode));
	});
}
