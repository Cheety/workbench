import { afterEach, describe, expect, test } from "bun:test";
import type { Sql } from "@workbench/sdk";
import { SQL } from "bun";
import { z } from "zod";
import { type ManualTimer, manualTimer } from "./testing/manual-timer.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	getTestDatabaseCertificate,
	PostgresGate,
	TEST_DATABASE_URL,
} from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";
import {
	openStatementCancellation,
	runInTransactionWithin,
	type TransactionHook,
} from "./transaction-deadline.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const BY_ADDRESS = "127.0.0.1";

const BY_NAME = "localhost";

describe("the connection that cancels statements", () => {
	test.each([
		{ sslmode: "disable", encrypted: false },
		{ sslmode: "prefer", encrypted: true },
		{ sslmode: "require", encrypted: true },
	])(
		"connects with sslmode=$sslmode, encrypted: $encrypted, and limits its statements to the statement_timeout it is opened with",
		async ({ sslmode, encrypted }) => {
			const cancellation = cancellationTo(BY_ADDRESS, { sslmode });

			const connection = await connectionSecurityOf(cancellation);

			expect(connection).toEqual({ ssl: encrypted, statement_timeout: "1min" });
		},
	);

	test.each(["verify-ca", "verify-full"])(
		"refuses with sslmode=%s a server whose certificate it is not given to trust",
		async (sslmode) => {
			const cancellation = cancellationTo(BY_NAME, { sslmode });

			const refused = cancellation`SELECT 1`;

			await expect(refused).rejects.toMatchObject({
				code: "DEPTH_ZERO_SELF_SIGNED_CERT",
			});
		},
	);

	test.each([
		{ sslmode: "verify-ca", host: BY_ADDRESS },
		{ sslmode: "verify-full", host: BY_NAME },
	])(
		"connects encrypted with sslmode=$sslmode to $host, trusting the certificate given as sslrootcert",
		async ({ sslmode, host }) => {
			const cancellation = cancellationTo(host, {
				sslmode,
				sslrootcert: await trustedCertificatePath(),
			});

			const connection = await connectionSecurityOf(cancellation);

			expect(connection).toEqual({ ssl: true, statement_timeout: "1min" });
		},
	);

	test("refuses with sslmode=verify-full a trusted certificate that does not name the host it connects to", async () => {
		const cancellation = cancellationTo(BY_ADDRESS, {
			sslmode: "verify-full",
			sslrootcert: await trustedCertificatePath(),
		});

		const refused = cancellation`SELECT 1`;

		await expect(refused).rejects.toMatchObject({
			code: "ERR_TLS_CERT_ALTNAME_INVALID",
		});
	});
});

const connectionSecurity = z.tuple([
	z.object({ ssl: z.boolean(), statement_timeout: z.string() }),
]);

function cancellationTo(
	host: string,
	parameters: Readonly<Record<string, string>>,
): SQL {
	const url = new URL(TEST_DATABASE_URL);
	url.hostname = host;
	for (const [key, value] of Object.entries(parameters))
		url.searchParams.set(key, value);
	const cancellation = openStatementCancellation(url.href, 60_000);
	cleanups.push(() => cancellation.close());
	return cancellation;
}

async function trustedCertificatePath(): Promise<string> {
	const certificate = await getTestDatabaseCertificate();
	cleanups.push(() => certificate.remove());
	return certificate.path;
}

async function connectionSecurityOf(
	cancellation: SQL,
): Promise<z.infer<typeof connectionSecurity>[0]> {
	const [row] = connectionSecurity.parse(
		await cancellation`
			SELECT ssl, current_setting('statement_timeout') AS statement_timeout
			FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
	);
	return row;
}

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

function poolBehindAGate(database: FreshDatabase): {
	readonly gate: PostgresGate;
	readonly pool: SQL;
} {
	const gate = PostgresGate.create(database.url);
	gate.forward();
	const pool = new SQL(gate.url, { max: 1 });
	cleanups.push(async () => {
		gate.release();
		await pool.close();
		gate.close();
	});
	return { gate, pool };
}

async function untilStatementsWaitForTheLock(
	observer: SQL,
	count: number,
): Promise<void> {
	let waiting: unknown[] = [];
	while (waiting.length < count)
		waiting = await observer`
			SELECT FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`;
}

async function settledExpiringEachTimer(
	running: Promise<unknown>,
	timer: ManualTimer,
): Promise<unknown> {
	const settled = running.then(
		() => ({ outcome: undefined }),
		(error: unknown) => ({ outcome: error }),
	);
	for (;;) {
		const timerSet = timer.set().then(() => undefined);
		if (timer.isPending()) {
			timer.expire();
			continue;
		}
		const next = await Promise.race([settled, timerSet]);
		if (next !== undefined) return next.outcome;
	}
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
		const givenUp = await settledExpiringEachTimer(running, timer);

		expect(givenUp).toBeInstanceOf(TimeIsUpError);
		expect(refusal).toMatchObject({ name: "StatementRefusedError" });
		expect(await notesIn(database.sql)).toEqual([]);
		expect(timer.delaysMs[0]).toBe(250);
		expect(timer.pendingCount()).toBe(0);
	});

	test("is given up while a statement of another connection goes on undisturbed", async () => {
		const database = await databaseWithNotes();
		const observer = await connectionHoldingTheHookLock(database);
		const bystander = new SQL(database.url, { max: 1 });
		cleanups.push(() => bystander.close());
		const timer = manualTimer();

		const timerSet = timer.set();
		const undisturbed =
			bystander`SELECT pg_advisory_xact_lock(${HOOK_LOCK})`.then(
				() => "finished",
				() => "cancelled",
			);
		const running = database.sql.begin(async (transaction) => {
			const outcome = await runInTransactionWithin(
				transaction,
				async ({ sql }) => {
					await sql`SELECT pg_advisory_xact_lock(${HOOK_LOCK})`;
				},
				{
					timeout: { ms: 250, setTimer: timer.setTimer },
					cancellation: database.cancellation,
					logger: recordingLogger().logger,
				},
			);
			if (outcome === "timed_out") throw new TimeIsUpError();
		});
		await timerSet;
		await untilStatementsWaitForTheLock(observer, 2);
		const givenUp = await settledExpiringEachTimer(running, timer);
		await observer`SELECT pg_advisory_unlock(${HOOK_LOCK})`;

		expect(givenUp).toBeInstanceOf(TimeIsUpError);
		expect(await undisturbed).toBe("finished");
		expect(timer.delaysMs[0]).toBe(250);
		expect(timer.pendingCount()).toBe(0);
	});
});

function poolWithTheStatementTimeoutOfAnInstance(database: FreshDatabase): SQL {
	const pool = new SQL(database.url, {
		max: 1,
		connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
	});
	cleanups.push(() => pool.close());
	return pool;
}

function cancellationThatIsRefused(database: FreshDatabase): SQL {
	const gate = PostgresGate.create(database.url);
	gate.refuse();
	const cancellation = new SQL(gate.url, { max: 1, connectionTimeout: 1 });
	cleanups.push(async () => {
		await cancellation.close();
		gate.close();
	});
	return cancellation;
}

const STATEMENT_TIMEOUT_MS = 60_000;

const statementTimeout = z.tuple([z.object({ statement_timeout: z.string() })]);

async function statementTimeoutIn(sql: Sql): Promise<string> {
	const [row] = statementTimeout.parse(await sql`SHOW statement_timeout`);
	return row.statement_timeout;
}

describe("a hook whose time is up while a statement of it cannot be cancelled", () => {
	test("is given up shortly after its time as Postgres ends the statement, not only after the statement_timeout of its connection", async () => {
		const database = await databaseWithNotes();
		const observer = await connectionHoldingTheHookLock(database);
		const pool = poolWithTheStatementTimeoutOfAnInstance(database);
		const { logger, entries } = recordingLogger();
		const timer = manualTimer();

		const timerSet = timer.set();
		const running = pool.begin(async (transaction) => {
			const outcome = await runInTransactionWithin(
				transaction,
				async ({ sql }) => {
					await sql`SELECT pg_advisory_xact_lock(${HOOK_LOCK})`;
				},
				{
					timeout: { ms: 50, setTimer: timer.setTimer },
					cancellation: cancellationThatIsRefused(database),
					logger,
				},
			);
			if (outcome === "timed_out") throw new TimeIsUpError();
		});
		await timerSet;
		await untilAStatementWaitsForTheLock(observer);
		timer.expire();
		const givenUp = await running.catch((error: unknown) => error);

		expect(givenUp).toBeInstanceOf(TimeIsUpError);
		expect(entries).toEqual([
			expect.objectContaining({ message: "statement not cancelled" }),
		]);
		expect([...(await pool`SELECT 1 AS served`)]).toEqual([{ served: 1 }]);
		expect(timer.delaysMs).toEqual([50]);
	});
});

describe("the statement_timeout around a hook", () => {
	test("is never raised for the statements of a hook whose time is longer", async () => {
		const database = await databaseWithNotes();
		const pool = poolWithTheStatementTimeoutOfAnInstance(database);
		const seen = Promise.withResolvers<string>();

		await pool.begin(async (transaction) => {
			await runInTransactionWithin(
				transaction,
				async ({ sql }) => {
					seen.resolve(await statementTimeoutIn(sql));
				},
				{
					timeout: { ms: 600_000, setTimer: manualTimer().setTimer },
					cancellation: database.cancellation,
					logger: recordingLogger().logger,
				},
			);
		});

		expect(await seen.promise).toBe("1min");
	});

	test("is again that of the connection for the statements after a hook that finished in time", async () => {
		const database = await databaseWithNotes();
		const pool = poolWithTheStatementTimeoutOfAnInstance(database);
		const timer = manualTimer();

		const after = await pool.begin(async (transaction) => {
			await runInTransactionWithin(
				transaction,
				async ({ sql }) => {
					await sql`INSERT INTO notes (note) VALUES ('written in time')`;
				},
				{
					timeout: { ms: 50, setTimer: timer.setTimer },
					cancellation: database.cancellation,
					logger: recordingLogger().logger,
				},
			);
			return statementTimeoutIn((strings, ...values) =>
				transaction(strings, ...values),
			);
		});

		expect(after).toBe("1min");
		expect(timer.delaysMs).toEqual([50]);
		expect(timer.pendingCount()).toBe(0);
	});
});

describe("a hook whose statement reaches Postgres only after its time is up", () => {
	test("has it cancelled by a further attempt, so that it is given up while the lock is still held", async () => {
		const database = await databaseWithNotes();
		const observer = await connectionHoldingTheHookLock(database);
		const { gate, pool } = poolBehindAGate(database);
		const timer = manualTimer();
		const begun = Promise.withResolvers<void>();
		const statementEnded = Promise.withResolvers<unknown>();
		const hook: TransactionHook = async ({ sql }) => {
			gate.holdRequests();
			const statement = sql`SELECT pg_advisory_xact_lock(${HOOK_LOCK})`;
			begun.resolve();
			statementEnded.resolve(
				await statement.then(
					() => "finished",
					(error: unknown) => error,
				),
			);
		};

		const running = pool.begin(async (transaction) => {
			const outcome = await runInTransactionWithin(transaction, hook, {
				timeout: { ms: 250, setTimer: timer.setTimer },
				cancellation: database.cancellation,
				logger: recordingLogger().logger,
			});
			if (outcome === "timed_out") throw new TimeIsUpError();
		});
		await begun.promise;
		const cancelledInVain = timer.set();
		timer.expire();
		await cancelledInVain;
		gate.release();
		await untilAStatementWaitsForTheLock(observer);
		const givenUp = await settledExpiringEachTimer(running, timer);

		expect(givenUp).toBeInstanceOf(TimeIsUpError);
		expect(await statementEnded.promise).toMatchObject({
			message: "canceling statement due to user request",
		});
		expect([...(await pool`SELECT 1 AS served`)]).toEqual([{ served: 1 }]);
		expect(timer.delaysMs[0]).toBe(250);
		expect(timer.pendingCount()).toBe(0);
	});
});
