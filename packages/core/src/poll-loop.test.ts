import { describe, expect, test } from "bun:test";
import type { SetTimer } from "./hook-timeout.ts";
import { startPollLoop } from "./poll-loop.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

const POLL_INTERVAL_MS = 1_000;

function manualTimer() {
	const delaysMs: number[] = [];
	let pending: (() => void) | undefined;
	let announce: (() => void) | undefined;
	const setTimer: SetTimer = (expire, delayMs) => {
		delaysMs.push(delayMs);
		pending = expire;
		announce?.();
		announce = undefined;
		return () => {
			if (pending === expire) pending = undefined;
		};
	};
	return {
		setTimer,
		delaysMs,
		isPending: () => pending !== undefined,
		nextSet: () =>
			new Promise<void>((resolve) => {
				announce = resolve;
			}),
		expire: () => {
			if (pending === undefined) throw new Error("no timer is pending");
			const expire = pending;
			pending = undefined;
			expire();
		},
	};
}

function controlledDelivery() {
	const running: {
		finish(): void;
		fail(error: Error): void;
	}[] = [];
	let started = 0;
	let atOnce = 0;
	let mostAtOnce = 0;
	let announce: (() => void) | undefined;
	return {
		delivery: {
			deliverDue: () => {
				started += 1;
				atOnce += 1;
				mostAtOnce = Math.max(mostAtOnce, atOnce);
				return new Promise<void>((resolve, reject) => {
					running.push({
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
	const loop = startPollLoop({
		run: () => deliveries.delivery.deliverDue(),
		failureMessage: "event delivery failed",
		pollIntervalMs: POLL_INTERVAL_MS,
		setTimer: timer.setTimer,
		logger,
	});
	return { loop, timer, deliveries, entries };
}

describe("the poll loop", () => {
	test("delivers nothing until it is woken or its poll interval expires", () => {
		const { timer, deliveries } = startLoop();

		expect(deliveries.started()).toBe(0);
		expect(timer.delaysMs).toEqual([POLL_INTERVAL_MS]);
	});

	test("delivers when its poll interval expires, and waits for the next interval once it is done", async () => {
		const { timer, deliveries } = startLoop();

		timer.expire();
		const waitingForNextInterval = timer.nextSet();
		deliveries.current().finish();
		await waitingForNextInterval;
		timer.expire();

		expect(deliveries.started()).toBe(2);
		expect(new Set(timer.delaysMs)).toEqual(new Set([POLL_INTERVAL_MS]));
	});

	test("delivers once more after wakes that arrive while it delivers, never twice at once", async () => {
		const { loop, timer, deliveries } = startLoop();

		loop.wake();
		loop.wake();
		loop.wake();
		const startedWhileDelivering = deliveries.started();
		const secondStart = deliveries.nextStart();
		deliveries.current().finish();
		await secondStart;
		const waitingForNextInterval = timer.nextSet();
		deliveries.current().finish();
		await waitingForNextInterval;

		expect(startedWhileDelivering).toBe(1);
		expect(deliveries.started()).toBe(2);
		expect(deliveries.mostAtOnce()).toBe(1);
	});

	test("tells the operator when a delivery run fails and delivers again at the next interval", async () => {
		const { loop, timer, deliveries, entries } = startLoop();

		loop.wake();
		const waitingForNextInterval = timer.nextSet();
		deliveries.current().fail(new Error("connection refused"));
		await waitingForNextInterval;
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

	test("tells a running delivery to stop, waits until it has wound down and delivers nothing afterwards", async () => {
		const timer = manualTimer();
		const journal: string[] = [];
		const woundDown = Promise.withResolvers<void>();
		let started = 0;
		const loop = startPollLoop({
			failureMessage: "event delivery failed",
			run: (stopSignal) => {
				started += 1;
				stopSignal.addEventListener("abort", () => {
					setImmediate(() => {
						journal.push("delivery wound down");
						woundDown.resolve();
					});
				});
				return woundDown.promise;
			},
			pollIntervalMs: POLL_INTERVAL_MS,
			setTimer: timer.setTimer,
			logger: recordingLogger().logger,
		});
		loop.wake();

		await loop.stop();
		journal.push("loop stopped");
		await woundDown.promise;
		loop.wake();

		expect(journal).toEqual(["delivery wound down", "loop stopped"]);
		expect(started).toBe(1);
		expect(timer.isPending()).toBe(false);
	});
});
