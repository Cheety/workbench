import { fileURLToPath } from "node:url";
import {
	type Config,
	InvalidConfigError,
	loadConfigFromEnvironment,
} from "./config.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { startPlugins } from "./kernel.ts";
import { createLogger } from "./logger.ts";
import { discoverPluginPackages } from "./plugin-discovery.ts";
import { createPostgresCheck } from "./postgres.ts";
import {
	type RunningServer,
	type ServerOptions,
	startServer,
} from "./server.ts";
import { shutDownInstance } from "./shutdown.ts";
import { systemFailureReason } from "./system-error.ts";

// The image holds the core and every plugin package of the repository side by
// side, so the plugin packages are the siblings of this package.
const PACKAGES_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

const CLOSED_PIPE = "EPIPE";

const now = (): Date => new Date();

// The instance outlives whoever reads its log: once stdout is closed there is
// nowhere left to report that, and it is no reason to stop serving.
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
const server = startServerOrExit({
	port: config.port,
	logger,
	checkDatabase: createPostgresCheck({
		url: config.databaseUrl,
		timeoutMs: config.readinessTimeoutMs,
	}),
	newCorrelationId: () => crypto.randomUUID(),
});
logger.info("server started", { port: server.port });

const plugins = startPlugins({
	discover: discoverPluginPackages(PACKAGES_DIRECTORY),
	enabledPlugins: config.enabledPlugins,
	capabilityProviders: {},
	hookTimeout: { ms: config.pluginHookTimeoutMs, setTimer: setSystemTimer },
	logger,
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		logger.info("shutting down", { signal });
		// A signal during startup waits for the plugins; the hook timeout bounds
		// that wait.
		void shutDownInstance({ server, plugins }, logger).then((exitCode) =>
			process.exit(exitCode),
		);
	});
}
