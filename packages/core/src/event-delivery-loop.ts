import type { EventDelivery } from "./event-outbox.ts";
import { describeThrown } from "./failure-reason.ts";
import type { SetTimer } from "./hook-timeout.ts";
import type { Logger } from "./logger.ts";

export type EventDeliveryLoopOptions = {
	readonly delivery: EventDelivery;
	readonly pollIntervalMs: number;
	readonly setTimer: SetTimer;
	readonly logger: Logger;
};

export type EventDeliveryLoop = {
	wake(): void;
	stop(): Promise<void>;
};

export function startEventDeliveryLoop(
	options: EventDeliveryLoopOptions,
): EventDeliveryLoop {
	const stopping = new AbortController();
	let running: Promise<void> | undefined;
	let isWokenWhileRunning = false;
	let cancelPoll = (): void => {};

	const waitForPoll = (): void => {
		cancelPoll = options.setTimer(wake, options.pollIntervalMs);
	};

	const deliver = async (): Promise<void> => {
		try {
			await options.delivery.deliverDue(stopping.signal);
		} catch (error) {
			options.logger.error("event delivery failed", {
				error: describeThrown(error),
			});
		}
	};

	const run = async (): Promise<void> => {
		do {
			isWokenWhileRunning = false;
			await deliver();
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
