import { afterEach, describe, expect, test } from "bun:test";
import {
	defineCronJob,
	defineJob,
	type JobDefinition,
	type SchemaResult,
} from "@workbench/sdk";
import { SQL } from "bun";
import { z } from "zod";
import { Secret } from "./config.ts";
import {
	type HookTimeout,
	type SetTimer,
	setSystemTimer,
} from "./hook-timeout.ts";
import { createJobQueue, enqueueJob } from "./job-queue.ts";
import { type JobRegistry, readJobs, registerJobs } from "./job-registry.ts";
import { startPollLoop } from "./poll-loop.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
} from "./schema-migrations.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	PostgresGate,
	TEST_DATABASE_URL,
} from "./testing/postgres.ts";
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

function registryOf<Payload = { cardId: string }>(
	...definitions: readonly JobDefinition<Payload>[]
): JobRegistry {
	return registerJobs(
		readJobs("mailer", { jobs: definitions, cronJobs: undefined }).value,
	);
}

const sendReminderWithStalledSchema: SendReminder = defineJob({
	name: "sendReminder",
	payload: {
		"~standard": {
			version: 1,
			vendor: "stalled",
			validate: () => new Promise<SchemaResult<{ cardId: string }>>(() => {}),
		},
	},
	maxAttempts: 3,
	run: async () => {},
});

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
	readonly cancellation: SQL;
	readonly jobs: JobRegistry;
	readonly now?: () => Date;
	readonly random?: () => number;
	readonly runTimeout?: HookTimeout;
	readonly newJobId?: () => string;
};

function queueOf(scenario: QueueScenario) {
	const { logger, entries } = recordingLogger();
	const queue = createJobQueue({
		sql: scenario.sql,
		cancellation: scenario.cancellation,
		jobs: scenario.jobs,
		now: scenario.now ?? (() => NOW),
		newId: () => "00000000-0000-4000-8000-000000000001",
		random: scenario.random ?? (() => 0.5),
		newJobId: scenario.newJobId ?? (() => crypto.randomUUID()),
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

async function enqueue<Payload>(
	sql: SQL,
	definition: JobDefinition<Payload>,
	payload: Payload,
): Promise<void> {
	await sql.begin((transaction) =>
		enqueueJob(transaction, registryOf(definition), {
			id: JOB,
			plugin: "mailer",
			definition,
			payload,
			enqueuedAt: NOW,
			workspace: WORKSPACE,
		}),
	);
}

async function payloadsRunWith<Payload>(
	database: FreshDatabase,
	schema: JobDefinition<Payload>["payload"],
	payload: Payload,
): Promise<Payload[]> {
	const received: Payload[] = [];
	const definition = defineJob({
		name: "sendReminder",
		payload: schema,
		maxAttempts: 3,
		run: async (job) => {
			received.push(job.payload);
		},
	});
	const { sql } = database;
	await enqueue(sql, definition, payload);
	const { queue } = queueOf({
		sql,
		cancellation: database.cancellation,
		jobs: registryOf(definition),
	});
	await queue.runDue(NOT_STOPPED);
	return received;
}

const RUN_LOCK = 4711;

async function connectionHoldingTheRunLock(
	database: FreshDatabase,
): Promise<SQL> {
	const connection = new SQL(database.url, { max: 1 });
	cleanups.push(() => connection.close());
	await connection`SELECT pg_advisory_lock(${RUN_LOCK})`;
	return connection;
}

async function untilAStatementWaitsForTheLock(observer: SQL): Promise<void> {
	let waiting: unknown[] = [];
	while (waiting.length === 0)
		waiting = await observer`
			SELECT FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`;
}

function waitingForTheRunLock(): SendReminder {
	return sendingReminders(async (_job, ctx) => {
		await ctx.sql`SELECT pg_advisory_xact_lock(${RUN_LOCK})`;
	});
}

function cancellationBehindAGate(database: FreshDatabase): {
	readonly gate: PostgresGate;
	readonly cancellation: SQL;
} {
	const gate = PostgresGate.create(database.url);
	gate.forward();
	const cancellation = new SQL(gate.url, { max: 1, prepare: false });
	cleanups.push(async () => {
		gate.release();
		await cancellation.close();
		gate.close();
	});
	return { gate, cancellation };
}

async function refuseNewConnections(database: FreshDatabase): Promise<void> {
	const name = new URL(database.url).pathname.slice(1);
	const admin = new SQL(TEST_DATABASE_URL, { max: 1 });
	try {
		await admin.unsafe(`ALTER DATABASE ${name} ALLOW_CONNECTIONS false`);
	} finally {
		await admin.close();
	}
}

function poolOfAnInstance(database: FreshDatabase): SQL {
	const pool = new SQL(database.url, {
		connectionTimeout: 10,
		connection: { statement_timeout: 60_000 },
	});
	cleanups.push(() => pool.close());
	return pool;
}

async function failureOf(sql: SQL): Promise<unknown[]> {
	const rows: unknown[] =
		await sql`SELECT state, attempts, failure_reason FROM core.jobs`;
	return [...rows];
}

describe("a job that exceeds its timeout", () => {
	test("counts as failed and runs again once its retry is due", async () => {
		const started = Promise.withResolvers<void>();
		const database = await migratedDatabase();
		const timer = manualTimer();
		const attempts: number[] = [];
		let now = NOW;
		const jobs = registryOf(
			sendingReminders((job) => {
				attempts.push(job.attempt);
				started.resolve();
				return job.attempt === 1 ? new Promise(() => {}) : Promise.resolve();
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
			runTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const running = queue.runDue(NOT_STOPPED);
		await timerSet;
		await started.promise;
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

	test("counts as failed when its payload schema does not finish validating in time", async () => {
		const database = await migratedDatabase();
		const timer = manualTimer();
		await enqueueReminder(
			database.sql,
			registryOf(sendingReminders(async () => {})),
			JOB,
		);
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: registryOf(sendReminderWithStalledSchema),
			runTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const running = queue.runDue(NOT_STOPPED);
		await timerSet;
		timer.expire();
		await running;

		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({
				jobId: JOB,
				attempt: 1,
				reason: "run_timed_out",
				timeoutMs: 250,
				retryInMs: 2500,
			}),
		]);
	});

	test("is not run when its payload schema finishes validating after its time is up", async () => {
		const database = await migratedDatabase();
		const timer = manualTimer();
		const validation =
			Promise.withResolvers<SchemaResult<{ cardId: string }>>();
		const run: string[] = [];
		await enqueueReminder(
			database.sql,
			registryOf(sendingReminders(async () => {})),
			JOB,
		);
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: registryOf(
				defineJob({
					name: "sendReminder",
					payload: {
						"~standard": {
							version: 1,
							vendor: "slow",
							validate: () => validation.promise,
						},
					},
					maxAttempts: 3,
					run: async (job) => {
						run.push(job.id);
					},
				}),
			),
			runTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const running = queue.runDue(NOT_STOPPED);
		await timerSet;
		timer.expire();
		await running;
		validation.resolve({ value: { cardId: "card-1" } });
		await database.sql`SELECT 1`;

		expect(run).toEqual([]);
	});

	test("is refused what it writes after its time is up, and leaves nothing of it behind", async () => {
		const started = Promise.withResolvers<void>();
		const database = await migratedDatabase();
		await createMailerSchema(database.sql);
		const timer = manualTimer();
		const timeIsUp = Promise.withResolvers<void>();
		const lateWrite = Promise.withResolvers<"written" | "refused">();
		const jobs = registryOf(
			sendingReminders(async (job, ctx) => {
				started.resolve();
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
			cancellation: database.cancellation,
			jobs,
			runTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const running = queue.runDue(NOT_STOPPED);
		await timerSet;
		await started.promise;
		timer.expire();
		await running;
		timeIsUp.resolve();
		const lateWriteOutcome = await lateWrite.promise;

		expect(lateWriteOutcome).toBe("refused");
		expect(await sentReminders(database.sql)).toEqual([]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ reason: "run_timed_out", attempt: 1 }),
		]);
	});
});

describe("a job whose time is up while a statement of its run is running", () => {
	test.each([
		["a single connection", (database: FreshDatabase) => database.sql],
		["the pool an instance builds from its URL", poolOfAnInstance],
	])(
		"is given up at once on %s, its statement cancelled and its failure stored",
		async (_case, poolOf) => {
			const database = await migratedDatabase();
			const sql = poolOf(database);
			const observer = await connectionHoldingTheRunLock(database);
			const timer = manualTimer();
			const jobs = registryOf(waitingForTheRunLock());
			await enqueueReminder(sql, jobs, JOB);
			const { queue, entries } = queueOf({
				sql,
				cancellation: database.cancellation,
				jobs,
				runTimeout: { ms: 250, setTimer: timer.setTimer },
			});

			const timerSet = timer.set();
			const running = queue.runDue(NOT_STOPPED);
			await timerSet;
			await untilAStatementWaitsForTheLock(observer);
			timer.expire();
			await running;

			expect(failuresIn(entries)).toEqual([
				expect.objectContaining({ reason: "run_timed_out", attempt: 1 }),
			]);
			expect(await failureOf(sql)).toEqual([
				{ state: "pending", attempts: 1, failure_reason: "run_timed_out" },
			]);
		},
	);

	test("is refused every further statement, so that its failure is stored while the lock it waited for is still held", async () => {
		const database = await migratedDatabase();
		const observer = await connectionHoldingTheRunLock(database);
		const { gate, cancellation } = cancellationBehindAGate(database);
		await cancellation`SELECT 1`;
		const timer = manualTimer();
		const furtherStatement = Promise.withResolvers<unknown>();
		const jobs = registryOf(
			sendingReminders(async (_job, ctx) => {
				await ctx.sql`SAVEPOINT before_the_lock`;
				await ctx.sql`SELECT pg_advisory_xact_lock(${RUN_LOCK})`.catch(
					() => {},
				);
				furtherStatement.resolve(
					await ctx.sql`ROLLBACK TO SAVEPOINT before_the_lock`.then(
						() => "run",
						(error: unknown) => error,
					),
				);
				await ctx.sql`SELECT pg_advisory_xact_lock(${RUN_LOCK})`;
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation,
			jobs,
			runTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const running = queue.runDue(NOT_STOPPED);
		await timerSet;
		await untilAStatementWaitsForTheLock(observer);
		gate.holdResponses();
		timer.expire();
		const refusal = await furtherStatement.promise;
		gate.release();
		await running;

		expect(refusal).toMatchObject({ name: "StatementRefusedError" });
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ reason: "run_timed_out", attempt: 1 }),
		]);
		expect(await failureOf(database.sql)).toEqual([
			{ state: "pending", attempts: 1, failure_reason: "run_timed_out" },
		]);
	});

	test("is given up once the statement ends when the statement cannot be cancelled, and tells the operator why", async () => {
		const database = await migratedDatabase();
		const observer = await connectionHoldingTheRunLock(database);
		const timer = manualTimer();
		const jobs = registryOf(waitingForTheRunLock());
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			runTimeout: { ms: 250, setTimer: timer.setTimer },
		});
		const notCancelled = () =>
			entries.filter((entry) => entry.message === "statement not cancelled");

		const timerSet = timer.set();
		const running = queue.runDue(NOT_STOPPED);
		await timerSet;
		await untilAStatementWaitsForTheLock(observer);
		await refuseNewConnections(database);
		timer.expire();
		while (notCancelled().length === 0) await observer`SELECT 1`;
		await observer`SELECT pg_advisory_unlock(${RUN_LOCK})`;
		await running;

		expect(notCancelled()).toEqual([
			expect.objectContaining({
				jobId: JOB,
				job: "mailer.sendReminder",
				attempt: 1,
				error: expect.objectContaining({ name: "PostgresError" }),
			}),
		]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ reason: "run_timed_out", attempt: 1 }),
		]);
	});
});

describe("the payload of a job", () => {
	test("is rejected when it is enqueued if its schema does not accept what the queue stores of it", async () => {
		const database = await migratedDatabase();
		const remindOn = defineJob({
			name: "sendReminder",
			payload: z.date(),
			maxAttempts: 3,
			run: async () => {},
		});

		const enqueueing = enqueue(database.sql, remindOn, NOW);

		expect(await enqueueing.catch((error: unknown) => error)).toMatchObject({
			name: "InvalidJobPayloadError",
			issues: [{ path: [], message: expect.stringContaining("date") }],
		});
	});

	test("is rejected when it is enqueued if its schema would change it again before the run", async () => {
		const database = await migratedDatabase();
		const remindTwice = defineJob({
			name: "sendReminder",
			payload: z.object({ times: z.number().transform((times) => times * 2) }),
			maxAttempts: 3,
			run: async () => {},
		});

		const enqueueing = enqueue(database.sql, remindTwice, { times: 1 });

		expect(await enqueueing.catch((error: unknown) => error)).toMatchObject({
			name: "InvalidJobPayloadError",
			issues: [{ path: [], message: expect.stringContaining("changes") }],
		});
	});

	test("reaches the run as its schema reads what the queue stored of it", async () => {
		const database = await migratedDatabase();

		const received = await payloadsRunWith(database, z.coerce.date(), NOW);

		expect(received).toEqual([NOW]);
	});

	test.each([
		["a number", 7],
		["a fraction", 1.5],
		["true", true],
		["false", false],
		["a string", "card-1"],
		["a string that reads as JSON", '{"cardId":7}'],
		["null", null],
		["a list", [7, "card-1", null]],
	])("reaches the run unchanged when it is %s", async (_case, payload) => {
		const database = await migratedDatabase();

		const received = await payloadsRunWith<unknown>(
			database,
			z.unknown(),
			payload,
		);

		expect(received).toEqual([payload]);
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
			cancellation: database.cancellation,
			jobs,
			now: () => now,
			runTimeout,
		}).queue.runDue(NOT_STOPPED);
		await entered.promise;
		const takingOver = queueOf({
			sql: second,
			cancellation: database.cancellation,
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
		const stalled = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});
		const stalledRun = stalled.queue.runDue(NOT_STOPPED);
		await entered.promise;

		now = new Date(NOW.getTime() + 70_000);
		await queueOf({
			sql: second,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		}).queue.runDue(NOT_STOPPED);
		release.resolve();
		await stalledRun;

		const rows: unknown[] =
			await database.sql`SELECT attempt FROM plugin_mailer.reminder_attempts`;
		expect([...rows]).toEqual([{ attempt: 2 }]);
		expect(stalled.entries).toEqual([]);
	});
});

describe("a job whose stalled attempt ends while the attempt that took it over still runs", () => {
	test("keeps what the attempt that took it over wrote, and nothing of the stalled one", async () => {
		const database = await migratedDatabase();
		await createMailerSchema(database.sql);
		const second = new SQL(database.url, { max: 1 });
		cleanups.push(() => second.close());
		const stalledEntered = Promise.withResolvers<void>();
		const takeoverEntered = Promise.withResolvers<void>();
		const releaseStalled = Promise.withResolvers<void>();
		const releaseTakeover = Promise.withResolvers<void>();
		let now = NOW;
		const jobs = registryOf(
			sendingReminders(async (job, ctx) => {
				if (job.attempt === 1) {
					stalledEntered.resolve();
					await releaseStalled.promise;
				} else {
					takeoverEntered.resolve();
					await releaseTakeover.promise;
				}
				await ctx.sql`INSERT INTO reminder_attempts (attempt) VALUES (${job.attempt})`;
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const stalled = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});
		const stalledRun = stalled.queue.runDue(NOT_STOPPED);
		await stalledEntered.promise;

		now = new Date(NOW.getTime() + 70_000);
		const takeover = queueOf({
			sql: second,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});
		const takeoverRun = takeover.queue.runDue(NOT_STOPPED);
		await takeoverEntered.promise;
		releaseStalled.resolve();
		await stalledRun;
		releaseTakeover.resolve();
		await takeoverRun;

		const rows: unknown[] =
			await database.sql`SELECT attempt FROM plugin_mailer.reminder_attempts`;
		expect([...rows]).toEqual([{ attempt: 2 }]);
		expect(stalled.entries).toEqual([]);
		expect(takeover.entries).toEqual([
			expect.objectContaining({ message: "job completed", attempt: 2 }),
		]);
	});
});

describe("a job that no active plugin declares", () => {
	test("is not attempted, and runs once a plugin that declares it is active again", async () => {
		const database = await migratedDatabase();
		const run: string[] = [];
		const declaring = registryOf(
			sendingReminders(async (job) => {
				run.push(job.id);
			}),
		);
		const notDeclaring = registryOf(
			defineJob({
				name: "archiveCard",
				payload: z.object({ cardId: z.string() }),
				maxAttempts: 3,
				run: async () => {},
			}),
		);
		await enqueueReminder(database.sql, declaring, JOB);
		const whileNotDeclared = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: notDeclaring,
		});

		await whileNotDeclared.queue.runDue(NOT_STOPPED);
		const rowsWhileNotDeclared: unknown[] = await database.sql`
			SELECT state, attempts FROM core.jobs`;
		await queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: declaring,
		}).queue.runDue(NOT_STOPPED);

		expect([...rowsWhileNotDeclared]).toEqual([
			{ state: "pending", attempts: 0 },
		]);
		expect(whileNotDeclared.entries).toEqual([]);
		expect(run).toEqual([JOB]);
	});
});

describe("a job whose last attempt neither completed nor failed", () => {
	test("is dead-lettered once its redelivery deadline has passed, without a further attempt", async () => {
		const database = await migratedDatabase();
		const second = new SQL(database.url, { max: 1 });
		cleanups.push(() => second.close());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const attempts: number[] = [];
		let now = NOW;
		const jobs = registryOf(
			defineJob({
				name: "sendReminder",
				payload: z.object({ cardId: z.string() }),
				maxAttempts: 1,
				run: async (job) => {
					attempts.push(job.attempt);
					entered.resolve();
					await release.promise;
				},
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const stalled = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});
		const stalledRun = stalled.queue.runDue(NOT_STOPPED);
		await entered.promise;
		const takingOver = queueOf({
			sql: second,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});

		now = new Date(NOW.getTime() + 70_000);
		await takingOver.queue.runDue(NOT_STOPPED);
		release.resolve();
		await stalledRun;

		const rows: unknown[] = await database.sql`
			SELECT state, attempts, failure_reason FROM core.jobs`;
		expect(attempts).toEqual([1]);
		expect([...rows]).toEqual([
			{ state: "dead", attempts: 1, failure_reason: "attempt_lost" },
		]);
		expect(takingOver.entries).toEqual([
			expect.objectContaining({
				level: "error",
				message: "job dead-lettered",
				jobId: JOB,
				job: "mailer.sendReminder",
				attempt: 1,
				reason: "attempt_lost",
			}),
		]);
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
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
		});

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
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: stricter,
		});

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
			cancellation: database.cancellation,
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
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});

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

	test("waits no longer than just under an hour for its retry, however many attempts failed before", async () => {
		const database = await migratedDatabase();
		let now = NOW;
		const jobs = registryOf(
			defineJob({
				name: "sendReminder",
				payload: z.object({ cardId: z.string() }),
				maxAttempts: 12,
				run: async () => {
					throw new Error("the mail server is down");
				},
			}),
		);
		await enqueueReminder(database.sql, jobs, JOB);
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
			random: () => 0.999,
		});

		for (let hoursLater = 0; hoursLater <= 10; hoursLater += 1) {
			now = new Date(NOW.getTime() + hoursLater * 3_600_000);
			await queue.runDue(NOT_STOPPED);
		}

		const rows: unknown[] = await database.sql`
			SELECT attempts, next_attempt_at FROM core.jobs`;
		expect(failuresIn(entries).at(-1)).toEqual(
			expect.objectContaining({ attempt: 11, retryInMs: 3_596_400 }),
		);
		expect([...rows]).toEqual([
			{
				attempts: 11,
				next_attempt_at: new Date("2026-11-27T19:59:56.400Z"),
			},
		]);
	});
});

function everyMinute(run: Date[]): JobRegistry {
	return registerJobs(
		readJobs("mailer", {
			jobs: undefined,
			cronJobs: [
				defineCronJob({
					name: "sendDigest",
					schedule: "* * * * *",
					maxAttempts: 3,
					run: async (job) => {
						run.push(job.dueAt);
					},
				}),
			],
		}).value,
	);
}

function skippedDueTimesIn(entries: readonly LogEntry[]): LogEntry[] {
	return entries.filter((entry) => entry.message === "cron due times skipped");
}

describe("a cron job whose due times pass before a run of the queue enqueues them", () => {
	test("runs for each due time since the last one that was enqueued, when a run of the queue took longer than its period", async () => {
		const database = await migratedDatabase();
		const run: Date[] = [];
		let now = new Date("2026-11-27T12:00:30.000Z");
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: everyMinute(run),
			now: () => now,
		});

		await queue.runDue(NOT_STOPPED);
		now = new Date("2026-11-27T12:02:05.000Z");
		await queue.runDue(NOT_STOPPED);
		now = new Date("2026-11-27T12:03:00.000Z");
		await queue.runDue(NOT_STOPPED);

		expect(run).toEqual([
			new Date("2026-11-27T12:01:00.000Z"),
			new Date("2026-11-27T12:02:00.000Z"),
			new Date("2026-11-27T12:03:00.000Z"),
		]);
	});

	test("runs for the one that was enqueued and for the ten latest it missed, however many passed while no instance ran", async () => {
		const database = await migratedDatabase();
		const run: Date[] = [];
		let now = new Date("2026-11-27T12:00:30.000Z");
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: everyMinute(run),
			now: () => now,
		});

		await queue.runDue(NOT_STOPPED);
		now = new Date("2026-12-04T12:00:30.000Z");
		await queue.runDue(NOT_STOPPED);
		await queue.runDue(NOT_STOPPED);

		expect(run).toEqual([
			new Date("2026-11-27T12:01:00.000Z"),
			new Date("2026-12-04T11:51:00.000Z"),
			new Date("2026-12-04T11:52:00.000Z"),
			new Date("2026-12-04T11:53:00.000Z"),
			new Date("2026-12-04T11:54:00.000Z"),
			new Date("2026-12-04T11:55:00.000Z"),
			new Date("2026-12-04T11:56:00.000Z"),
			new Date("2026-12-04T11:57:00.000Z"),
			new Date("2026-12-04T11:58:00.000Z"),
			new Date("2026-12-04T11:59:00.000Z"),
			new Date("2026-12-04T12:00:00.000Z"),
		]);
	});

	test("tells the operator once which due times it skipped, when more than ten passed", async () => {
		const database = await migratedDatabase();
		let now = new Date("2026-11-27T12:00:30.000Z");
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: everyMinute([]),
			now: () => now,
		});

		await queue.runDue(NOT_STOPPED);
		now = new Date("2026-11-27T12:12:30.000Z");
		await queue.runDue(NOT_STOPPED);
		now = new Date("2026-11-27T12:13:00.000Z");
		await queue.runDue(NOT_STOPPED);

		expect(skippedDueTimesIn(entries)).toEqual([
			expect.objectContaining({
				level: "warn",
				job: "mailer.sendDigest",
				latestEnqueuedDueAt: "2026-11-27T12:01:00.000Z",
				oldestCaughtUpDueAt: "2026-11-27T12:03:00.000Z",
			}),
		]);
	});

	test("warns of no skipped due time when it catches up on all ten that passed", async () => {
		const database = await migratedDatabase();
		const run: Date[] = [];
		let now = new Date("2026-11-27T12:00:30.000Z");
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: everyMinute(run),
			now: () => now,
		});

		await queue.runDue(NOT_STOPPED);
		now = new Date("2026-11-27T12:11:30.000Z");
		await queue.runDue(NOT_STOPPED);

		expect(run).toHaveLength(11);
		expect(skippedDueTimesIn(entries)).toEqual([]);
	});

	test("runs for the due times another process left out, not again for those it enqueued", async () => {
		const database = await migratedDatabase();
		const second = new SQL(database.url, { max: 1 });
		cleanups.push(() => second.close());
		const run: Date[] = [];
		const jobs = everyMinute(run);
		let now = new Date("2026-11-27T12:00:30.000Z");
		const first = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});
		const other = queueOf({
			sql: second,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});

		await first.queue.runDue(NOT_STOPPED);
		now = new Date("2026-11-27T12:01:00.000Z");
		await first.queue.runDue(NOT_STOPPED);
		now = new Date("2026-11-27T12:03:10.000Z");
		await other.queue.runDue(NOT_STOPPED);

		expect(run).toEqual([
			new Date("2026-11-27T12:01:00.000Z"),
			new Date("2026-11-27T12:02:00.000Z"),
			new Date("2026-11-27T12:03:00.000Z"),
		]);
	});
});

describe("a cron job of an instance with two processes", () => {
	test("is scheduled and run once for each time it falls due", async () => {
		const database = await migratedDatabase();
		const second = new SQL(database.url, { max: 1 });
		cleanups.push(() => second.close());
		const run: Date[] = [];
		const jobs = registerJobs(
			readJobs("mailer", {
				jobs: undefined,
				cronJobs: [
					defineCronJob({
						name: "sendDigest",
						schedule: "*/5 * * * *",
						maxAttempts: 3,
						run: async (job) => {
							run.push(job.dueAt);
						},
					}),
				],
			}).value,
		);
		let now = new Date("2026-11-27T09:00:30.000Z");
		const first = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});
		const other = queueOf({
			sql: second,
			cancellation: database.cancellation,
			jobs,
			now: () => now,
		});
		const runDueInBoth = () =>
			Promise.all([
				first.queue.runDue(NOT_STOPPED),
				other.queue.runDue(NOT_STOPPED),
			]);

		await runDueInBoth();
		now = new Date("2026-11-27T09:05:00.000Z");
		await runDueInBoth();
		now = new Date("2026-11-27T09:10:00.000Z");
		await runDueInBoth();

		const rows: unknown[] = await database.sql`
			SELECT name, due_at, state FROM core.jobs ORDER BY due_at`;
		expect(run).toEqual([
			new Date("2026-11-27T09:05:00.000Z"),
			new Date("2026-11-27T09:10:00.000Z"),
		]);
		expect([...rows]).toEqual([
			{
				name: "mailer.sendDigest",
				due_at: new Date("2026-11-27T09:05:00.000Z"),
				state: "completed",
			},
			{
				name: "mailer.sendDigest",
				due_at: new Date("2026-11-27T09:10:00.000Z"),
				state: "completed",
			},
			{
				name: "mailer.sendDigest",
				due_at: new Date("2026-11-27T09:15:00.000Z"),
				state: "pending",
			},
		]);
	});

	test("is not enqueued by a mutation under the name of a job", async () => {
		const database = await migratedDatabase();
		const jobs = registerJobs(
			readJobs("mailer", {
				jobs: undefined,
				cronJobs: [
					defineCronJob({
						name: "sendReminder",
						schedule: "*/5 * * * *",
						maxAttempts: 3,
						run: async () => {},
					}),
				],
			}).value,
		);

		const enqueued = enqueueReminder(database.sql, jobs, JOB);

		await expect(enqueued).rejects.toThrow(
			'"mailer" enqueued the job "mailer.sendReminder", which it does not declare among its jobs',
		);
	});
});

const DAY_MS = 86_400_000;

const HOUR_MS = 3_600_000;

function removalsIn(entries: readonly LogEntry[]): LogEntry[] {
	return entries.filter((entry) => entry.message === "settled jobs removed");
}

async function insertRemindersCompletedAt(
	sql: SQL,
	completedAt: Date,
	count: number,
): Promise<void> {
	await sql`
		INSERT INTO core.jobs (id, name, payload, workspace_id, enqueued_at, next_attempt_at, state, settled_at)
		SELECT gen_random_uuid(), 'mailer.sendReminder', '{"cardId": "card-1"}'::jsonb, ${WORKSPACE}, ${completedAt}, ${completedAt}, 'completed', ${completedAt}
		FROM generate_series(1, ${count})`;
}

async function countJobs(sql: SQL): Promise<unknown> {
	const [row]: unknown[] =
		await sql`SELECT count(*)::integer AS jobs FROM core.jobs`;
	return row;
}

describe("a settled job", () => {
	test.each([
		{ state: "completed", days: 7, run: async () => {} },
		{
			state: "dead",
			days: 30,
			run: async () => {
				throw new Error("the address does not exist");
			},
		},
	])(
		"is removed from the queue $days days after it was settled as $state, and not before",
		async ({ state, days, run }) => {
			const database = await migratedDatabase();
			const jobs = registryOf(
				defineJob({
					name: "sendReminder",
					payload: z.object({ cardId: z.string() }),
					maxAttempts: 1,
					run,
				}),
			);
			await enqueueReminder(database.sql, jobs, JOB);
			await queueOf({
				sql: database.sql,
				cancellation: database.cancellation,
				jobs,
			}).queue.runDue(NOT_STOPPED);
			const justBefore = queueOf({
				sql: database.sql,
				cancellation: database.cancellation,
				jobs,
				now: () => new Date(NOW.getTime() + days * DAY_MS - 1),
			});
			const onTheDay = queueOf({
				sql: database.sql,
				cancellation: database.cancellation,
				jobs,
				now: () => new Date(NOW.getTime() + days * DAY_MS),
			});

			await justBefore.queue.runDue(NOT_STOPPED);
			const rowsJustBefore: unknown[] =
				await database.sql`SELECT id, state FROM core.jobs`;
			await onTheDay.queue.runDue(NOT_STOPPED);

			expect([...rowsJustBefore]).toEqual([{ id: JOB, state }]);
			expect(await countJobs(database.sql)).toEqual({ jobs: 0 });
			expect(removalsIn(justBefore.entries)).toEqual([]);
			expect(removalsIn(onTheDay.entries)).toEqual([
				expect.objectContaining({ level: "debug", removed: 1 }),
			]);
		},
	);
});

describe("a pending job", () => {
	test("stays in the queue however long ago it was enqueued", async () => {
		const database = await migratedDatabase();
		await enqueueReminder(
			database.sql,
			registryOf(sendingReminders(async () => {})),
			JOB,
		);
		const notDeclaring = registryOf(
			defineJob({
				name: "archiveCard",
				payload: z.object({ cardId: z.string() }),
				maxAttempts: 3,
				run: async () => {},
			}),
		);
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: notDeclaring,
			now: () => new Date(NOW.getTime() + 365 * DAY_MS),
		});

		await queue.runDue(NOT_STOPPED);

		const rows: unknown[] = await database.sql`SELECT id, state FROM core.jobs`;
		expect([...rows]).toEqual([{ id: JOB, state: "pending" }]);
	});
});

describe("settled jobs past their retention", () => {
	test("are removed a thousand in a run of the queue, and the rest in the next run", async () => {
		const database = await migratedDatabase();
		await insertRemindersCompletedAt(
			database.sql,
			new Date(NOW.getTime() - 8 * DAY_MS),
			1_001,
		);
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: registryOf(sendingReminders(async () => {})),
		});

		await queue.runDue(NOT_STOPPED);
		const leftAfterTheFirstRun = await countJobs(database.sql);
		await queue.runDue(NOT_STOPPED);

		expect(leftAfterTheFirstRun).toEqual({ jobs: 1 });
		expect(await countJobs(database.sql)).toEqual({ jobs: 0 });
	});

	test("are not looked for again by a process until an hour after it removed all there were", async () => {
		const database = await migratedDatabase();
		let now = NOW;
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: registryOf(sendingReminders(async () => {})),
			now: () => now,
		});
		await queue.runDue(NOT_STOPPED);
		await insertRemindersCompletedAt(
			database.sql,
			new Date(NOW.getTime() - 8 * DAY_MS),
			1,
		);

		now = new Date(NOW.getTime() + HOUR_MS - 1);
		await queue.runDue(NOT_STOPPED);
		const leftWithinTheHour = await countJobs(database.sql);
		now = new Date(NOW.getTime() + HOUR_MS);
		await queue.runDue(NOT_STOPPED);

		expect(leftWithinTheHour).toEqual({ jobs: 1 });
		expect(await countJobs(database.sql)).toEqual({ jobs: 0 });
	});
});

describe("a cron job whose due times are all past their retention", () => {
	test("keeps its latest due time in the queue, and catches up from it once its plugin is active again", async () => {
		const database = await migratedDatabase();
		await database.sql`
			INSERT INTO core.jobs (id, name, due_at, enqueued_at, next_attempt_at, state, settled_at)
			SELECT gen_random_uuid(), 'mailer.sendDigest', due.at, due.at, due.at, 'completed', due.at
			FROM unnest(ARRAY[
				'2026-10-01T12:01:00.000Z',
				'2026-10-01T12:02:00.000Z',
				'2026-10-01T12:03:00.000Z'
			]::timestamptz[]) AS due (at)`;
		const run: Date[] = [];
		const whileNotDeclared = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: registryOf(sendingReminders(async () => {})),
		});
		const declaredAgain = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: everyMinute(run),
			now: () => new Date("2026-11-27T09:00:30.000Z"),
		});

		await whileNotDeclared.queue.runDue(NOT_STOPPED);
		const keptDueTimes: unknown[] =
			await database.sql`SELECT due_at FROM core.jobs`;
		await declaredAgain.queue.runDue(NOT_STOPPED);

		expect([...keptDueTimes]).toEqual([
			{ due_at: new Date("2026-10-01T12:03:00.000Z") },
		]);
		expect(run).toHaveLength(10);
		expect(run.at(-1)).toEqual(new Date("2026-11-27T09:00:00.000Z"));
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
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
		});
		const loop = startPollLoop({
			run: (stopSignal) => queue.runDue(stopSignal),
			failureMessage: "job queue failed",
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
		const { queue, entries } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
		});
		const timer = manualTimer();
		const { logger, entries: loopEntries } = recordingLogger();
		const loop = startPollLoop({
			run: (stopSignal) => queue.runDue(stopSignal),
			failureMessage: "job queue failed",
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
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs: registryOf(),
		});

		const run = queue.runDue(NOT_STOPPED);

		await expect(run).resolves.toBeUndefined();
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

		const first = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
		}).queue.runDue(NOT_STOPPED);
		await entered.promise;
		await queueOf({
			sql: second,
			cancellation: database.cancellation,
			jobs,
		}).queue.runDue(NOT_STOPPED);
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
		const { queue } = queueOf({
			sql: database.sql,
			cancellation: database.cancellation,
			jobs,
		});

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
