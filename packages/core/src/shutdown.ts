import { describeThrown } from "./failure-reason.ts";
import type { RunningPlugins } from "./kernel.ts";
import type { Logger } from "./logger.ts";
import type { RunningServer } from "./server.ts";
import { systemFailureReason } from "./system-error.ts";

export type ExitCode = 0 | 1;

type Deactivatable = Pick<RunningPlugins, "deactivate">;

export type RunningInstance = {
	readonly server: Pick<RunningServer, "stop">;
	/** The plugins of the instance, which may still be starting. */
	readonly plugins: Deactivatable | Promise<Deactivatable>;
};

/**
 * Waits for the plugins to have started, so that every activated plugin is
 * deactivated. Then stops taking requests and deactivates the plugins, so
 * that no request reaches a plugin that is already shutting down. Each step
 * runs even if the one before it failed.
 *
 * Never rejects: a failure is logged and yields exit code 1.
 */
export async function shutDownInstance(
	instance: RunningInstance,
	logger: Logger,
): Promise<ExitCode> {
	const plugins = Promise.resolve(instance.plugins);
	// A failed start is reported by deactivatePlugins, after the server stopped.
	await plugins.catch(() => {});
	const serverExitCode = await shutDown(instance.server, logger);
	const pluginsExitCode = await deactivatePlugins(plugins, logger);
	return serverExitCode === 0 ? pluginsExitCode : 1;
}

async function deactivatePlugins(
	plugins: Promise<Deactivatable>,
	logger: Logger,
): Promise<ExitCode> {
	try {
		const started = await plugins;
		return (await started.deactivate()) === "clean" ? 0 : 1;
	} catch (error) {
		logger.error("plugins failed to shut down", {
			error: describeThrown(error),
		});
		return 1;
	}
}

export async function shutDown(
	server: Pick<RunningServer, "stop">,
	logger: Logger,
): Promise<ExitCode> {
	try {
		await server.stop();
		return 0;
	} catch (error) {
		logger.error("server failed to stop", {
			reason: systemFailureReason(error),
		});
		return 1;
	}
}
