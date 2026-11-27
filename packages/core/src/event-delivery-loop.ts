import type { EventDelivery } from "./event-outbox.ts";
import type { SetTimer } from "./hook-timeout.ts";
import type { Logger } from "./logger.ts";
import { type PollLoop, startPollLoop } from "./poll-loop.ts";

export type EventDeliveryLoopOptions = {
	readonly delivery: EventDelivery;
	readonly pollIntervalMs: number;
	readonly setTimer: SetTimer;
	readonly logger: Logger;
};

export type EventDeliveryLoop = PollLoop;

export function startEventDeliveryLoop(
	options: EventDeliveryLoopOptions,
): EventDeliveryLoop {
	return startPollLoop({
		run: (stopSignal) => options.delivery.deliverDue(stopSignal),
		failureMessage: "event delivery failed",
		pollIntervalMs: options.pollIntervalMs,
		setTimer: options.setTimer,
		logger: options.logger,
	});
}
