import type { SetTimer } from "./hook-timeout.ts";
import type { Logger } from "./logger.ts";
import type { DatabaseCheck } from "./postgres.ts";

export type DatabaseWait = {
	readonly check: DatabaseCheck;
	readonly retryDelayMs: (attempt: number) => number;
	readonly setTimer: SetTimer;
	readonly stopSignal: AbortSignal;
	readonly logger: Logger;
};

export type DatabaseWaitOutcome = "reachable" | "stopped";

export async function untilDatabaseReachable(
	wait: DatabaseWait,
): Promise<DatabaseWaitOutcome> {
	for (let attempt = 0; !wait.stopSignal.aborted; attempt += 1) {
		const status = await wait.check(wait.logger);
		if (status.reachable) return "reachable";
		if (wait.stopSignal.aborted) break;
		const retryInMs = wait.retryDelayMs(attempt);
		wait.logger.warn("database unreachable, retrying", {
			reason: status.reason,
			retryInMs,
		});
		await pauseUnlessStopped(retryInMs, wait.setTimer, wait.stopSignal);
	}
	return "stopped";
}

export function pauseUnlessStopped(
	delayMs: number,
	setTimer: SetTimer,
	stopSignal: AbortSignal,
): Promise<void> {
	return new Promise((resolve) => {
		const stop = () => {
			cancel();
			resolve();
		};
		const cancel = setTimer(() => {
			stopSignal.removeEventListener("abort", stop);
			resolve();
		}, delayMs);
		stopSignal.addEventListener("abort", stop, { once: true });
	});
}

export type Backoff = {
	readonly baseMs: number;
	readonly capMs: number;
	readonly random: () => number;
};

export function fullJitterBackoff({
	baseMs,
	capMs,
	random,
}: Backoff): (attempt: number) => number {
	return (attempt) =>
		Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}
