import type { EventDeliveryLoop } from "./event-delivery-loop.ts";
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
	readonly eventDelivery: Pick<EventDeliveryLoop, "stop">;
	readonly plugins: Deactivatable | Promise<Deactivatable>;
	readonly database: { readonly close: () => Promise<void> };
};

export async function shutDownInstance(
	instance: RunningInstance,
	logger: Logger,
): Promise<ExitCode> {
	instance.stopStartingPlugins();
	const plugins = Promise.resolve(instance.plugins);
	await plugins.catch(() => {});
	const serverExitCode = await shutDown(instance.server, logger);
	const eventDeliveryExitCode = await stopEventDelivery(
		instance.eventDelivery,
		logger,
	);
	const pluginsExitCode = await deactivatePlugins(plugins, logger);
	const databaseExitCode = await closeDatabase(instance.database, logger);
	return serverExitCode === 0 &&
		eventDeliveryExitCode === 0 &&
		pluginsExitCode === 0
		? databaseExitCode
		: 1;
}

async function stopEventDelivery(
	eventDelivery: RunningInstance["eventDelivery"],
	logger: Logger,
): Promise<ExitCode> {
	try {
		await eventDelivery.stop();
		return 0;
	} catch (error) {
		logger.error("event delivery failed to stop", {
			error: describeThrown(error),
		});
		return 1;
	}
}

async function closeDatabase(
	database: RunningInstance["database"],
	logger: Logger,
): Promise<ExitCode> {
	try {
		await database.close();
		return 0;
	} catch (error) {
		logger.error("database connections failed to close", {
			error: describeThrown(error),
		});
		return 1;
	}
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
