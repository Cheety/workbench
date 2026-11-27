import type { SetTimer } from "./hook-timeout.ts";
import type { JobQueue } from "./job-queue.ts";
import type { Logger } from "./logger.ts";
import { type PollLoop, startPollLoop } from "./poll-loop.ts";

export type JobLoopOptions = {
	readonly queue: JobQueue;
	readonly pollIntervalMs: number;
	readonly setTimer: SetTimer;
	readonly logger: Logger;
};

export type JobLoop = PollLoop;

export function startJobLoop(options: JobLoopOptions): JobLoop {
	return startPollLoop({
		run: (stopSignal) => options.queue.runDue(stopSignal),
		failureMessage: "job queue failed",
		pollIntervalMs: options.pollIntervalMs,
		setTimer: options.setTimer,
		logger: options.logger,
	});
}
