import { describe, expect, test } from "bun:test";
import { fullJitterBackoff, untilDatabaseReachable } from "./database-wait.ts";
import type { SetTimer } from "./hook-timeout.ts";
import type { DatabaseStatus } from "./postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

function answering(...statuses: DatabaseStatus[]) {
	let checks = 0;
	return {
		check: async (): Promise<DatabaseStatus> => {
			const status = statuses[Math.min(checks, statuses.length - 1)];
			checks += 1;
			if (status === undefined) throw new Error("no status given");
			return status;
		},
		checks: () => checks,
	};
}

const UNREACHABLE: DatabaseStatus = {
	reachable: false,
	reason: "ECONNREFUSED",
};
const REACHABLE: DatabaseStatus = { reachable: true };

function immediateTimers() {
	const delaysMs: number[] = [];
	const setTimer: SetTimer = (expire, delayMs) => {
		delaysMs.push(delayMs);
		queueMicrotask(expire);
		return () => {};
	};
	return { setTimer, delaysMs };
}

describe("waiting for the database", () => {
	test("goes on at once when the database is reachable", async () => {
		const database = answering(REACHABLE);
		const timers = immediateTimers();

		const outcome = await untilDatabaseReachable({
			check: database.check,
			retryDelayMs: () => 100,
			setTimer: timers.setTimer,
			stopSignal: new AbortController().signal,
			logger: recordingLogger().logger,
		});

		expect(outcome).toBe("reachable");
		expect(timers.delaysMs).toEqual([]);
	});

	test("checks again after each retry delay until the database is reachable and says why it waits", async () => {
		const database = answering(UNREACHABLE, UNREACHABLE, REACHABLE);
		const timers = immediateTimers();
		const { logger, entries } = recordingLogger();

		const outcome = await untilDatabaseReachable({
			check: database.check,
			retryDelayMs: (attempt) => 100 * (attempt + 1),
			setTimer: timers.setTimer,
			stopSignal: new AbortController().signal,
			logger,
		});

		expect(outcome).toBe("reachable");
		expect(database.checks()).toBe(3);
		expect(timers.delaysMs).toEqual([100, 200]);
		expect(entries).toEqual([
			expect.objectContaining({
				level: "warn",
				message: "database unreachable, retrying",
				reason: "ECONNREFUSED",
				retryInMs: 100,
			}),
			expect.objectContaining({
				level: "warn",
				message: "database unreachable, retrying",
				reason: "ECONNREFUSED",
				retryInMs: 200,
			}),
		]);
	});

	test("stops waiting and stops the clock when it is told to stop", async () => {
		const database = answering(UNREACHABLE);
		const stop = new AbortController();
		let cancelled = 0;
		const setTimer: SetTimer = () => {
			queueMicrotask(() => stop.abort());
			return () => {
				cancelled += 1;
			};
		};

		const outcome = await untilDatabaseReachable({
			check: database.check,
			retryDelayMs: () => 100,
			setTimer,
			stopSignal: stop.signal,
			logger: recordingLogger().logger,
		});

		expect(outcome).toBe("stopped");
		expect(database.checks()).toBe(1);
		expect(cancelled).toBe(1);
	});

	test("does not wait for the retry delay when it is told to stop while checking", async () => {
		const stop = new AbortController();
		const delaysMs: number[] = [];

		const outcome = await untilDatabaseReachable({
			check: async () => {
				stop.abort();
				return UNREACHABLE;
			},
			retryDelayMs: () => 100,
			setTimer: (_expire, delayMs) => {
				delaysMs.push(delayMs);
				return () => {};
			},
			stopSignal: stop.signal,
			logger: recordingLogger().logger,
		});

		expect(outcome).toBe("stopped");
		expect(delaysMs).toEqual([]);
	});

	test("does not check at all when it is told to stop beforehand", async () => {
		const database = answering(REACHABLE);
		const stop = new AbortController();
		stop.abort();

		const outcome = await untilDatabaseReachable({
			check: database.check,
			retryDelayMs: () => 100,
			setTimer: immediateTimers().setTimer,
			stopSignal: stop.signal,
			logger: recordingLogger().logger,
		});

		expect(outcome).toBe("stopped");
		expect(database.checks()).toBe(0);
	});
});

describe("full jitter backoff", () => {
	test("draws each delay between zero and a doubling ceiling that stops at the cap", () => {
		const delay = fullJitterBackoff({
			baseMs: 250,
			capMs: 2000,
			random: () => 0.5,
		});

		expect([0, 1, 2, 3, 4, 10].map(delay)).toEqual([
			125, 250, 500, 1000, 1000, 1000,
		]);
	});
});
