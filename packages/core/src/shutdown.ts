import { describeThrown } from "./failure-reason.ts";
import type { RunningPlugins } from "./kernel.ts";
import type { Logger } from "./logger.ts";
import type { RunningServer } from "./server.ts";
import { systemFailureReason } from "./system-error.ts";

export type ExitCode = 0 | 1;

type Deactivatable = Pick<RunningPlugins, "deactivate">;

export type RunningInstance = {
	readonly stopStartingPlugins: () => void;
	readonly server: Pick<RunningServer, "stop">;
	readonly plugins: Deactivatable | Promise<Deactivatable>;
};

export async function shutDownInstance(
	instance: RunningInstance,
	logger: Logger,
): Promise<ExitCode> {
	instance.stopStartingPlugins();
	const plugins = Promise.resolve(instance.plugins);
	await plugins.catch(() => {});
	const serverExitCode = await shutDown(instance.server, logger);
	const pluginsExitCode = await deactivatePlugins(plugins, logger);
	return serverExitCode === 0 ? pluginsExitCode : 1;
}

export function reportFailedStart(
	starting: Promise<Deactivatable>,
	logger: Logger,
): Promise<Deactivatable> {
	return starting.catch((error: unknown) => {
		logger.error("plugins failed to start", {
			error: describeThrown(error),
		});
		return { deactivate: async () => "incomplete" };
	});
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
