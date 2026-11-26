import type { Logger } from "./logger.ts";
import type { RunningServer } from "./server.ts";
import { systemFailureReason } from "./system-error.ts";

export type ExitCode = 0 | 1;

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
