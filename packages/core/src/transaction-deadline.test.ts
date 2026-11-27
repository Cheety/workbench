import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { z } from "zod";
import { manualTimer } from "./testing/manual-timer.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	PostgresGate,
	TEST_DATABASE_URL,
} from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";
import {
	openStatementCancellation,
	runInTransactionWithin,
	type TransactionHook,
} from "./transaction-deadline.ts";

const connectionSettings = z.object({
	sslMode: z.number(),
	tls: z.unknown(),
	query: z.string(),
});

describe("the connection that cancels statements", () => {
	test.each(["disable", "prefer", "require", "verify-ca", "verify-full"])(
		"verifies the server and limits its statements as the pool of the same URL does with sslmode=%s",
		async (mode) => {
			const url = `${TEST_DATABASE_URL}?sslmode=${mode}`;
			const pool = new SQL(url, { connection: { statement_timeout: 60_000 } });
			const cancellation = openStatementCancellation(url, 60_000);

			expect(connectionSettings.parse(cancellation.options)).toEqual(
				connectionSettings.parse(pool.options),
			);
			await cancellation.close();
			await pool.close();
		},
	);
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const HOOK_LOCK = 4712;

class TimeIsUpError extends Error {
	constructor() {
		super("the time of the hook is up");
		this.name = "TimeIsUpError";
	}
}

async function databaseWithNotes(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	await database.sql`CREATE TABLE notes (note text NOT NULL)`;
	return database;
}

async function connectionHoldingTheHookLock(
	database: FreshDatabase,
): Promise<SQL> {
	const connection = new SQL(database.url, { max: 1 });
	cleanups.push(() => connection.close());
	await connection`SELECT pg_advisory_lock(${HOOK_LOCK})`;
	return connection;
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

async function untilAStatementWaitsForTheLock(observer: SQL): Promise<void> {
	let waiting: unknown[] = [];
	while (waiting.length === 0)
		waiting = await observer`
			SELECT FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`;
}

async function notesIn(sql: SQL): Promise<unknown[]> {
	const rows: unknown[] = await sql`SELECT note FROM notes`;
	return [...rows];
}

describe("a hook whose time is up while a statement of it is running", () => {
	test("is refused every further statement, so that it is given up at once and nothing of it is committed", async () => {
		const database = await databaseWithNotes();
		const observer = await connectionHoldingTheHookLock(database);
		const { gate, cancellation } = cancellationBehindAGate(database);
		await cancellation`SELECT 1`;
		const timer = manualTimer();
		const furtherStatement = Promise.withResolvers<unknown>();
		const hook: TransactionHook = async ({ sql }) => {
			await sql`INSERT INTO notes (note) VALUES ('written in time')`;
			await sql`SAVEPOINT before_the_lock`;
			await sql`SELECT pg_advisory_xact_lock(${HOOK_LOCK})`.catch(() => {});
			furtherStatement.resolve(
				await sql`ROLLBACK TO SAVEPOINT before_the_lock`.then(
					() => "run",
					(error: unknown) => error,
				),
			);
			await sql`SELECT pg_advisory_xact_lock(${HOOK_LOCK})`;
		};

		const timerSet = timer.set();
		const running = database.sql.begin(async (transaction) => {
			const outcome = await runInTransactionWithin(transaction, hook, {
				timeout: { ms: 250, setTimer: timer.setTimer },
				cancellation,
				logger: recordingLogger().logger,
			});
			if (outcome === "timed_out") throw new TimeIsUpError();
		});
		await timerSet;
		await untilAStatementWaitsForTheLock(observer);
		gate.holdResponses();
		timer.expire();
		const refusal = await furtherStatement.promise;
		gate.release();
		const givenUp = await running.catch((error: unknown) => error);

		expect(givenUp).toBeInstanceOf(TimeIsUpError);
		expect(refusal).toMatchObject({
			name: "StatementRefusedError",
			message: "statement refused: the time of its hook is up",
		});
		expect(await notesIn(database.sql)).toEqual([]);
	});
});
