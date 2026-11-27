import { describeThrown } from "./failure-reason.ts";
import type { SetTimer } from "./hook-timeout.ts";
import type { Logger } from "./logger.ts";

export type PollLoopOptions = {
	readonly run: (stopSignal: AbortSignal) => Promise<void>;
	readonly failureMessage: string;
	readonly pollIntervalMs: number;
	readonly setTimer: SetTimer;
	readonly logger: Logger;
};

export type PollLoop = {
	wake(): void;
	stop(): Promise<void>;
};

export function startPollLoop(options: PollLoopOptions): PollLoop {
	const stopping = new AbortController();
	let running: Promise<void> | undefined;
	let isWokenWhileRunning = false;
	let cancelPoll = (): void => {};

	const waitForPoll = (): void => {
		cancelPoll = options.setTimer(wake, options.pollIntervalMs);
	};

	const runOnce = async (): Promise<void> => {
		try {
			await options.run(stopping.signal);
		} catch (error) {
			options.logger.error(options.failureMessage, {
				error: describeThrown(error),
			});
		}
	};

	const run = async (): Promise<void> => {
		do {
			isWokenWhileRunning = false;
			await runOnce();
		} while (isWokenWhileRunning && !stopping.signal.aborted);
		running = undefined;
		if (!stopping.signal.aborted) waitForPoll();
	};

	function wake(): void {
		if (stopping.signal.aborted) return;
		if (running !== undefined) {
			isWokenWhileRunning = true;
			return;
		}
		cancelPoll();
		running = run();
		void running;
	}

	waitForPoll();
	return {
		wake,
		stop: async () => {
			stopping.abort();
			cancelPoll();
			await running;
		},
	};
}
