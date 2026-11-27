import { describe, expect, test } from "bun:test";
import { startEventDeliveryLoop } from "./event-delivery-loop.ts";
import type { SetTimer } from "./hook-timeout.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

const POLL_INTERVAL_MS = 1_000;

function manualTimer() {
	const delaysMs: number[] = [];
	let pending: (() => void) | undefined;
	const setTimer: SetTimer = (expire, delayMs) => {
		delaysMs.push(delayMs);
		pending = expire;
		return () => {
			if (pending === expire) pending = undefined;
		};
	};
	return {
		setTimer,
		delaysMs,
		isPending: () => pending !== undefined,
		expire: () => {
			if (pending === undefined) throw new Error("no timer is pending");
			const expire = pending;
			pending = undefined;
			expire();
		},
	};
}

function settled(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function controlledDelivery() {
	const running: {
		readonly stopSignal: AbortSignal;
		finish(): void;
		fail(error: Error): void;
	}[] = [];
	let started = 0;
	let atOnce = 0;
	let mostAtOnce = 0;
	let announce: (() => void) | undefined;
	return {
		delivery: {
			deliverDue: (stopSignal: AbortSignal) => {
				started += 1;
				atOnce += 1;
				mostAtOnce = Math.max(mostAtOnce, atOnce);
				return new Promise<void>((resolve, reject) => {
					running.push({
						stopSignal,
						finish: () => {
							atOnce -= 1;
							resolve();
						},
						fail: (error) => {
							atOnce -= 1;
							reject(error);
						},
					});
					announce?.();
					announce = undefined;
				});
			},
		},
		started: () => started,
		mostAtOnce: () => mostAtOnce,
		current: () => {
			const latest = running.at(-1);
			if (latest === undefined) throw new Error("no delivery has started");
			return latest;
		},
		nextStart: () =>
			new Promise<void>((resolve) => {
				announce = resolve;
			}),
	};
}

function startLoop() {
	const timer = manualTimer();
	const deliveries = controlledDelivery();
	const { logger, entries } = recordingLogger();
	const loop = startEventDeliveryLoop({
		delivery: deliveries.delivery,
		pollIntervalMs: POLL_INTERVAL_MS,
		setTimer: timer.setTimer,
		logger,
	});
	return { loop, timer, deliveries, entries };
}

describe("the event delivery loop", () => {
	test("delivers nothing until it is woken or its poll interval expires", () => {
		const { timer, deliveries } = startLoop();

		expect(deliveries.started()).toBe(0);
		expect(timer.delaysMs).toEqual([POLL_INTERVAL_MS]);
	});

	test("delivers at once when it is woken", () => {
		const { loop, deliveries } = startLoop();

		loop.wake();

		expect(deliveries.started()).toBe(1);
	});

	test("delivers when its poll interval expires, and waits for the next interval once it is done", async () => {
		const { timer, deliveries } = startLoop();

		timer.expire();
		const pendingWhileDelivering = timer.isPending();
		const secondStart = deliveries.nextStart();
		deliveries.current().finish();
		await settled();
		timer.expire();
		await secondStart;

		expect(pendingWhileDelivering).toBe(false);
		expect(deliveries.started()).toBe(2);
		expect(timer.delaysMs).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
	});

	test("delivers once more after wakes that arrive while it delivers, never twice at once", async () => {
		const { loop, deliveries } = startLoop();

		loop.wake();
		loop.wake();
		loop.wake();
		const startedWhileDelivering = deliveries.started();
		const secondStart = deliveries.nextStart();
		deliveries.current().finish();
		await secondStart;
		deliveries.current().finish();
		await settled();

		expect(startedWhileDelivering).toBe(1);
		expect(deliveries.started()).toBe(2);
		expect(deliveries.mostAtOnce()).toBe(1);
	});

	test("tells the operator when a delivery run fails and delivers again at the next interval", async () => {
		const { loop, timer, deliveries, entries } = startLoop();

		loop.wake();
		deliveries.current().fail(new Error("connection refused"));
		await settled();
		timer.expire();

		expect(entries).toEqual([
			expect.objectContaining({
				level: "error",
				message: "event delivery failed",
				error: expect.objectContaining({ message: "connection refused" }),
			}),
		]);
		expect(deliveries.started()).toBe(2);
	});

	test("tells a running delivery to stop, waits for it and delivers nothing afterwards", async () => {
		const { loop, timer, deliveries } = startLoop();
		loop.wake();
		let stopped = false;

		const stopping = loop.stop().then(() => {
			stopped = true;
		});
		await settled();
		const stoppedWhileDelivering = stopped;
		const toldToStop = deliveries.current().stopSignal.aborted;
		deliveries.current().finish();
		await stopping;
		loop.wake();

		expect(toldToStop).toBe(true);
		expect(stoppedWhileDelivering).toBe(false);
		expect(deliveries.started()).toBe(1);
		expect(timer.isPending()).toBe(false);
	});
});
