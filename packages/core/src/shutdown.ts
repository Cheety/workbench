import type { RunningPlugins } from "./kernel.ts";
import type { Logger } from "./logger.ts";
import type { RunningServer } from "./server.ts";
import { systemFailureReason } from "./system-error.ts";

export type ExitCode = 0 | 1;

export type RunningInstance = {
	readonly server: Pick<RunningServer, "stop">;
	readonly plugins: Pick<RunningPlugins, "deactivate">;
};

/**
 * Stops taking requests, then deactivates the plugins, so that no request
 * reaches a plugin that is already shutting down. Each step runs even if the
 * one before it failed.
 */
export async function shutDownInstance(
	instance: RunningInstance,
	logger: Logger,
): Promise<ExitCode> {
	const serverExitCode = await shutDown(instance.server, logger);
	const deactivation = await instance.plugins.deactivate();
	return deactivation === "clean" ? serverExitCode : 1;
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
