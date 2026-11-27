import { afterEach, describe, expect, test } from "bun:test";
import { Secret } from "./config.ts";
import { fullJitterBackoff, untilDatabaseReachable } from "./database-wait.ts";
import type { SetTimer } from "./hook-timeout.ts";
import { createPostgresCheck, type DatabaseStatus } from "./postgres.ts";
import { PostgresGate } from "./testing/postgres.ts";
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
	reason: "ERR_POSTGRES_CONNECTION_REFUSED",
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
	let gate: PostgresGate | undefined;

	afterEach(() => {
		gate?.close();
		gate = undefined;
	});

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
		const refusing = PostgresGate.create();
		gate = refusing;
		const delaysMs: number[] = [];
		const setTimer: SetTimer = (expire, delayMs) => {
			delaysMs.push(delayMs);
			if (delaysMs.length === 2) refusing.forward();
			queueMicrotask(expire);
			return () => {};
		};
		const { logger, entries } = recordingLogger();

		const outcome = await untilDatabaseReachable({
			check: createPostgresCheck({
				url: new Secret(refusing.url),
				timeoutMs: 5000,
			}),
			retryDelayMs: (attempt) => 100 * (attempt + 1),
			setTimer,
			stopSignal: new AbortController().signal,
			logger,
		});

		expect(outcome).toBe("reachable");
		expect(delaysMs).toEqual([100, 200]);
		expect(refusing.acceptedConnections).toBe(1);
		expect(entries).toEqual([
			expect.objectContaining({
				level: "warn",
				message: "database unreachable, retrying",
				reason: "ERR_POSTGRES_CONNECTION_REFUSED",
				retryInMs: 100,
			}),
			expect.objectContaining({
				level: "warn",
				message: "database unreachable, retrying",
				reason: "ERR_POSTGRES_CONNECTION_REFUSED",
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
	test.each([
		["zero", 0, [0, 0, 0, 0, 0, 0]],
		[
			"just under the doubling ceiling",
			0.9999,
			[249, 499, 999, 1999, 1999, 1999],
		],
	])(
		"draws each delay at %s when the random draw is %d, with the ceiling stopping at the cap",
		(_bound, draw, delaysMs) => {
			const delay = fullJitterBackoff({
				baseMs: 250,
				capMs: 2000,
				random: () => draw,
			});

			expect([0, 1, 2, 3, 4, 10].map(delay)).toEqual(delaysMs);
		},
	);
});
