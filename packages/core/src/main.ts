import {
	type Config,
	InvalidConfigError,
	loadConfigFromEnvironment,
} from "./config.ts";
import { createLogger } from "./logger.ts";
import { createPostgresCheck } from "./postgres.ts";
import { startServer } from "./server.ts";

const now = (): Date => new Date();

function loadConfigOrExit(): Config {
	try {
		return loadConfigFromEnvironment();
	} catch (error) {
		if (!(error instanceof InvalidConfigError)) throw error;
		// The log level is part of the configuration that just failed, so this
		// entry goes out unconditionally, and to stderr.
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

const config = loadConfigOrExit();
const logger = createLogger({
	level: config.logLevel,
	now,
	write: (line) => process.stdout.write(`${line}\n`),
});
const server = startServer({
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
