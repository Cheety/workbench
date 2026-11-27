import { afterEach, describe, expect, test } from "bun:test";
import { defineJob, type JobDefinition } from "@workbench/sdk";
import { SQL } from "bun";
import { z } from "zod";
import { Secret } from "./config.ts";
import {
	type HookTimeout,
	type SetTimer,
	setSystemTimer,
} from "./hook-timeout.ts";
import { startJobLoop } from "./job-loop.ts";
import { createJobQueue, enqueueJob } from "./job-queue.ts";
import { type JobRegistry, readJobs, registerJobs } from "./job-registry.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
} from "./schema-migrations.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { type LogEntry, recordingLogger } from "./testing/recording-logger.ts";
import { createWorkspace } from "./workspaces.ts";

const NOW = new Date("2026-11-27T09:00:00.000Z");

const WORKSPACE = "00000000-0000-4000-8000-00000000aaaa";

const JOB = "00000000-0000-4000-b000-000000000001";

const NOT_STOPPED = new AbortController().signal;

const NEVER_EXPIRING: HookTimeout = { ms: 10_000, setTimer: () => () => {} };

type SendReminder = JobDefinition<{ cardId: string }>;

function sendingReminders(run: SendReminder["run"]): SendReminder {
	return defineJob({
		name: "sendReminder",
		payload: z.object({ cardId: z.string() }),
		maxAttempts: 3,
		run,
	});
}

function registryOf(
	...definitions: readonly JobDefinition<{ cardId: string }>[]
): JobRegistry {
	return registerJobs(readJobs("mailer", definitions).value);
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	return database;
}

async function migratedDatabase(): Promise<FreshDatabase> {
	const database = await freshDatabase();
	const runner: MigrationRunner = {
		databaseUrl: new Secret(database.url),
		connectionTimeoutMs: 10_000,
		statementTimeoutMs: 60_000,
		lockRetryDelayMs: () => 0,
		setTimer: setSystemTimer,
		logger: recordingLogger().logger,
	};
	await migrateCoreSchema(runner, CORE_MIGRATIONS_DIRECTORY, NOT_STOPPED);
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Alpha",
		createdAt: NOW,
	});
	return database;
}

async function enqueueReminder(
	sql: SQL,
	jobs: JobRegistry,
	id: string,
): Promise<void> {
	await sql.begin((transaction) =>
		enqueueJob(transaction, jobs, {
			id,
			plugin: "mailer",
			definition: sendingReminders(async () => {}),
			payload: { cardId: "card-1" },
			enqueuedAt: NOW,
			workspace: WORKSPACE,
		}),
	);
}

type QueueScenario = {
	readonly sql: SQL;
	readonly jobs: JobRegistry;
	readonly now?: () => Date;
	readonly random?: () => number;
	readonly runTimeout?: HookTimeout;
};

function queueOf(scenario: QueueScenario) {
	const { logger, entries } = recordingLogger();
	const queue = createJobQueue({
		sql: scenario.sql,
		jobs: scenario.jobs,
		now: scenario.now ?? (() => NOW),
		newId: () => "00000000-0000-4000-8000-000000000001",
		random: scenario.random ?? (() => 0.5),
		runTimeout: scenario.runTimeout ?? NEVER_EXPIRING,
		logger,
	});
	return { queue, entries };
}

function manualTimer() {
	let expire: (() => void) | undefined;
	let announce: (() => void) | undefined;
	const setTimer: SetTimer = (onExpire) => {
		expire = onExpire;
		announce?.();
		return () => {
			expire = undefined;
		};
	};
	return {
		setTimer,
		set: () =>
			new Promise<void>((resolve) => {
				announce = resolve;
			}),
		expire: () => {
			if (expire === undefined) throw new Error("no timer is pending");
			expire();
		},
	};
}

async function createMailerSchema(sql: SQL): Promise<void> {
	await sql.unsafe(`
		CREATE SCHEMA plugin_mailer;
		CREATE TABLE plugin_mailer.sent_reminders (job_id uuid PRIMARY KEY);
		CREATE TABLE plugin_mailer.reminder_attempts (attempt integer NOT NULL);
		CREATE TABLE plugin_mailer.reminder_receipts (
			job_id uuid PRIMARY KEY
				REFERENCES plugin_mailer.sent_reminders (job_id)
				DEFERRABLE INITIALLY DEFERRED
		);
	`);
}

async function sentReminders(sql: SQL): Promise<unknown[]> {
	const rows: unknown[] =
		await sql`SELECT job_id FROM plugin_mailer.sent_reminders ORDER BY job_id`;
	return [...rows];
}

function failuresIn(entries: readonly LogEntry[]): LogEntry[] {
	return entries.filter((entry) => entry.message === "job failed");
}

describe("a job that exceeds its timeout", () => {
	test("counts as failed and runs again once its retry is due", async () => {
		const database = await migratedDatabase();
		const timer = manualTimer();
		const attempts: number[] = [];
		let now = NOW;
		const jobs = registryOf(
			sendingReminders((job) => {
				attempts.push(job.attempt);
				return job.attempt === 1 ? new Promise(() => {}) : Promise.resolve();
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue, entries } = queueOf({
			sql: database.sql,
			jobs,
			now: () => now,
			runTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const running = queue.runDue(NOT_STOPPED);
		await timerSet;
		timer.expire();
		await running;
		await queue.runDue(NOT_STOPPED);
		const attemptsBeforeTheRetryIsDue = [...attempts];
		now = new Date(NOW.getTime() + 2_500);
		await queue.runDue(NOT_STOPPED);

		expect(attemptsBeforeTheRetryIsDue).toEqual([1]);
		expect(attempts).toEqual([1, 2]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({
				jobId: JOB,
				job: "mailer.sendReminder",
				attempt: 1,
				reason: "run_timed_out",
				timeoutMs: 250,
				retryInMs: 2500,
			}),
		]);
	});

	test("leaves nothing behind of what it writes after its time is up", async () => {
		const database = await migratedDatabase();
		await createMailerSchema(database.sql);
		const timer = manualTimer();
		const timeIsUp = Promise.withResolvers<void>();
		const lateWrite = Promise.withResolvers<"written" | "refused">();
		const jobs = registryOf(
			sendingReminders(async (job, ctx) => {
				await timeIsUp.promise;
				await ctx.sql`INSERT INTO sent_reminders (job_id) VALUES (${job.id})`.then(
					() => lateWrite.resolve("written"),
					() => lateWrite.resolve("refused"),
				);
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue, entries } = queueOf({
			sql: database.sql,
			jobs,
			runTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const running = queue.runDue(NOT_STOPPED);
		await timerSet;
		timer.expire();
		timeIsUp.resolve();
		await running;
		await lateWrite.promise;

		expect(await sentReminders(database.sql)).toEqual([]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ reason: "run_timed_out", attempt: 1 }),
		]);
	});
});

describe("a job whose attempt neither completed nor failed", () => {
	test("is run again once its redelivery deadline has passed, which is later than the timeout of a run", async () => {
		const database = await migratedDatabase();
		const second = new SQL(database.url, { max: 1 });
		cleanups.push(() => second.close());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const attempts: number[] = [];
		let now = NOW;
		const jobs = registryOf(
			sendingReminders(async (job) => {
				attempts.push(job.attempt);
				entered.resolve();
				if (job.attempt === 1) await release.promise;
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const runTimeout: HookTimeout = { ms: 10_000, setTimer: () => () => {} };
		const stalled = queueOf({
			sql: database.sql,
			jobs,
			now: () => now,
			runTimeout,
		}).queue.runDue(NOT_STOPPED);
		await entered.promise;
		const takingOver = queueOf({
			sql: second,
			jobs,
			now: () => now,
			runTimeout,
		});

		now = new Date(NOW.getTime() + 10_000);
		await takingOver.queue.runDue(NOT_STOPPED);
		const attemptsAtTheTimeout = [...attempts];
		now = new Date(NOW.getTime() + 70_000);
		await takingOver.queue.runDue(NOT_STOPPED);
		release.resolve();
		await stalled;

		expect(attemptsAtTheTimeout).toEqual([1]);
		expect(attempts).toEqual([1, 2]);
	});

	test("keeps what the attempt that took it over wrote, and nothing of the stalled one", async () => {
		const database = await migratedDatabase();
		await createMailerSchema(database.sql);
		const second = new SQL(database.url, { max: 1 });
		cleanups.push(() => second.close());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let now = NOW;
		const jobs = registryOf(
			sendingReminders(async (job, ctx) => {
				entered.resolve();
				if (job.attempt === 1) await release.promise;
				await ctx.sql`INSERT INTO reminder_attempts (attempt) VALUES (${job.attempt})`;
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const stalled = queueOf({ sql: database.sql, jobs, now: () => now });
		const stalledRun = stalled.queue.runDue(NOT_STOPPED);
		await entered.promise;

		now = new Date(NOW.getTime() + 70_000);
		await queueOf({ sql: second, jobs, now: () => now }).queue.runDue(
			NOT_STOPPED,
		);
		release.resolve();
		await stalledRun;

		const rows: unknown[] =
			await database.sql`SELECT attempt FROM plugin_mailer.reminder_attempts`;
		expect([...rows]).toEqual([{ attempt: 2 }]);
		expect(stalled.entries).toEqual([]);
	});
});

describe("a job that fails outside its run function", () => {
	test("counts the attempt and waits for its retry when its transaction cannot be committed", async () => {
		const database = await migratedDatabase();
		await createMailerSchema(database.sql);
		const attempts: number[] = [];
		const jobs = registryOf(
			sendingReminders(async (job, ctx) => {
				attempts.push(job.attempt);
				await ctx.sql`INSERT INTO reminder_receipts (job_id) VALUES (${job.id})`;
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue, entries } = queueOf({ sql: database.sql, jobs });

		await queue.runDue(NOT_STOPPED);
		await queue.runDue(NOT_STOPPED);

		expect(attempts).toEqual([1]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({
				jobId: JOB,
				attempt: 1,
				reason: "attempt_failed",
				error: expect.objectContaining({ name: "PostgresError" }),
				retryInMs: 2500,
			}),
		]);
	});

	test("is dead-lettered at once, without a retry, when its definition rejects the payload it was enqueued with", async () => {
		const database = await migratedDatabase();
		const run: string[] = [];
		const enqueuedWith = registryOf(sendingReminders(async () => {}));
		const stricter = registryOf(
			defineJob({
				name: "sendReminder",
				payload: z.object({ cardId: z.uuid() }),
				maxAttempts: 3,
				run: async (job) => {
					run.push(job.id);
				},
			}),
		);
		await enqueueReminder(database.sql, enqueuedWith, JOB);
		const { queue, entries } = queueOf({ sql: database.sql, jobs: stricter });

		await queue.runDue(NOT_STOPPED);

		expect(run).toEqual([]);
		expect(entries).toEqual([
			expect.objectContaining({
				level: "error",
				message: "job dead-lettered",
				jobId: JOB,
				attempt: 1,
				reason: "invalid_payload",
				issues: [expect.objectContaining({ path: ["cardId"] })],
			}),
		]);
	});
});

describe("a job that fails", () => {
	test("is not retried in the run of the queue in which it failed, even when the jitter draws no wait", async () => {
		const database = await migratedDatabase();
		const attempts: number[] = [];
		const jobs = registryOf(
			sendingReminders(async (job) => {
				attempts.push(job.attempt);
				throw new Error("the mail server is down");
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue, entries } = queueOf({
			sql: database.sql,
			jobs,
			random: () => 0,
		});

		await queue.runDue(NOT_STOPPED);

		expect(attempts).toEqual([1]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ attempt: 1, retryInMs: 1 }),
		]);
	});

	test("stays in the queue as dead after its last attempt, with the reason of its last failure", async () => {
		const database = await migratedDatabase();
		let now = NOW;
		const jobs = registryOf(
			sendingReminders(async () => {
				throw new Error("the address does not exist");
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue } = queueOf({ sql: database.sql, jobs, now: () => now });

		await queue.runDue(NOT_STOPPED);
		now = new Date(NOW.getTime() + 3_600_000);
		await queue.runDue(NOT_STOPPED);
		now = new Date(NOW.getTime() + 7_200_000);
		await queue.runDue(NOT_STOPPED);

		const rows: unknown[] = await database.sql`
			SELECT name, state, attempts, failure_reason, settled_at FROM core.jobs`;
		expect([...rows]).toEqual([
			{
				name: "mailer.sendReminder",
				state: "dead",
				attempts: 3,
				failure_reason: "run_threw",
				settled_at: new Date("2026-11-27T11:00:00.000Z"),
			},
		]);
	});
});

describe("the job loop on the queue", () => {
	test("runs a job when it is woken, without waiting for its poll interval", async () => {
		const database = await migratedDatabase();
		const run: string[] = [];
		const firstRun = Promise.withResolvers<void>();
		const jobs = registryOf(
			sendingReminders(async (job) => {
				run.push(job.id);
				firstRun.resolve();
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue } = queueOf({ sql: database.sql, jobs });
		const loop = startJobLoop({
			queue,
			pollIntervalMs: 1_000,
			setTimer: () => () => {},
			logger: recordingLogger().logger,
		});
		cleanups.push(() => loop.stop());

		loop.wake();
		await firstRun.promise;
		await loop.stop();
		await queue.runDue(NOT_STOPPED);

		expect(run).toEqual([JOB]);
	});

	test("tells the operator when a run of the queue fails as a whole, and waits for the next interval", async () => {
		const database = await freshDatabase();
		const jobs = registryOf(sendingReminders(async () => {}));
		const { queue, entries } = queueOf({ sql: database.sql, jobs });
		const timer = manualTimer();
		const { logger, entries: loopEntries } = recordingLogger();
		const loop = startJobLoop({
			queue,
			pollIntervalMs: 1_000,
			setTimer: timer.setTimer,
			logger,
		});
		cleanups.push(() => loop.stop());

		const waitingForNextInterval = timer.set();
		loop.wake();
		await waitingForNextInterval;

		expect(entries).toEqual([]);
		expect(loopEntries).toEqual([
			expect.objectContaining({
				level: "error",
				message: "job queue failed",
				error: expect.objectContaining({ name: "PostgresError" }),
			}),
		]);
	});
});

describe("the job queue", () => {
	test("asks Postgres for nothing while no plugin declares a job, so it may run before the core schema exists", async () => {
		const database = await freshDatabase();
		const { queue, entries } = queueOf({
			sql: database.sql,
			jobs: registryOf(),
		});

		await queue.runDue(NOT_STOPPED);

		expect(entries).toEqual([]);
	});

	test("hands a job to its run function once when two processes run the due jobs at the same time", async () => {
		const database = await migratedDatabase();
		const second = new SQL(database.url, { max: 1 });
		cleanups.push(() => second.close());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const run: string[] = [];
		const jobs = registryOf(
			sendingReminders(async (job) => {
				run.push(job.id);
				entered.resolve();
				await release.promise;
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);

		const first = queueOf({ sql: database.sql, jobs }).queue.runDue(
			NOT_STOPPED,
		);
		await entered.promise;
		await queueOf({ sql: second, jobs }).queue.runDue(NOT_STOPPED);
		release.resolve();
		await first;

		expect(run).toEqual([JOB]);
	});

	test("runs no further job once it is told to stop, and leaves the rest for the next run", async () => {
		const database = await migratedDatabase();
		const stopping = new AbortController();
		const run: string[] = [];
		const jobs = registryOf(
			sendingReminders(async (job) => {
				run.push(job.id);
				stopping.abort();
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		await enqueueReminder(
			database.sql,
			jobs,
			"00000000-0000-4000-b000-000000000002",
		);
		const { queue } = queueOf({ sql: database.sql, jobs });

		await queue.runDue(stopping.signal);
		const runBeforeTheNextRun = run.length;
		await queue.runDue(NOT_STOPPED);

		expect(runBeforeTheNextRun).toBe(1);
		expect(run.toSorted()).toEqual([
			JOB,
			"00000000-0000-4000-b000-000000000002",
		]);
	});
});
