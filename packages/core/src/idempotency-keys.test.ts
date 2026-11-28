import { afterEach, describe, expect, test } from "bun:test";
import {
	type Actor,
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
	OperationError,
} from "@workbench/sdk";
import { SQL } from "bun";
import { z } from "zod";
import { Secret } from "./config.ts";
import { CORE_JOBS } from "./core-jobs.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { createJobQueue, type JobQueue } from "./job-queue.ts";
import { registerJobs } from "./job-registry.ts";
import { type PluginPackage, startPlugins } from "./kernel.ts";
import { grantMembership } from "./memberships.ts";
import {
	createOperationPipeline,
	type OperationPipeline,
} from "./operation-pipeline.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "./schema-migrations.ts";
import {
	type HarnessCall,
	type OperationHarness,
	type OperationHarnessOptions,
	startOperationHarness,
} from "./testing/operation-harness.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";
import { createWorkspace } from "./workspaces.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

const BOB: Actor = { kind: "user", id: "bob" };

const ALICE_AS_SERVICE_ACCOUNT: Actor = {
	kind: "service_account",
	id: "alice",
};

const MEMBERS = [
	{ actor: ALICE, role: "owner" },
	{ actor: BOB, role: "owner" },
	{ actor: ALICE_AS_SERVICE_ACCOUNT, role: "owner" },
] as const;

const entry = z.object({ id: z.string(), amount: z.number().int() });

const addEntry = defineOperation({
	name: "addEntry",
	kind: "mutation",
	target: "workspace",
	right: "ledger.entry.add",
	input: z.object({ amount: z.number().int() }),
	output: entry,
	execute: async ({ amount }, ctx) => {
		const id = ctx.newId();
		await ctx.sql`INSERT INTO entries (id, workspace_id, amount) VALUES (${id}, ${ctx.workspace}, ${amount})`;
		if (amount === 0)
			throw new OperationError(
				"rejected",
				"zero_amount",
				"an entry needs an amount other than zero",
			);
		return { id, amount };
	},
});

const listEntries = defineOperation({
	name: "listEntries",
	kind: "query",
	target: "workspace",
	right: "ledger.entry.read",
	input: z.object({}),
	output: z.object({ entries: z.array(entry) }),
	execute: async (_input, ctx) => {
		const rows =
			await ctx.sql`SELECT id, amount FROM entries WHERE workspace_id = ${ctx.workspace} ORDER BY id`;
		return { entries: z.array(entry).parse(rows) };
	},
});

const ENTRY_LOCK = 4712;

const addEntryBehindALock = defineOperation({
	...addEntry,
	name: "addEntryBehindLock",
	execute: async (input, ctx) => {
		await ctx.sql`SELECT pg_advisory_xact_lock(${ENTRY_LOCK})`;
		return addEntry.execute(input, ctx);
	},
});

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () =>
		definePlugin({
			manifest: { name: "ledger", capabilities: [DATABASE_CAPABILITY] },
			rights: [
				{ name: "ledger.entry.add", defaultRoles: ["owner"] },
				{ name: "ledger.entry.read", defaultRoles: ["owner"] },
			],
			operations: [addEntry, addEntryBehindALock, listEntries],
		}),
	loadMigrations: async () => [
		{
			name: "0001_create_entries.sql",
			sql: "CREATE TABLE entries (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, amount integer NOT NULL);",
		},
	],
};

const harnesses: OperationHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.stop();
});

async function startLedger(
	options: Omit<OperationHarnessOptions, "plugins"> = {},
): Promise<OperationHarness> {
	const harness = await startOperationHarness({
		...options,
		plugins: [ledger],
	});
	harnesses.push(harness);
	return harness;
}

function addingEntry(
	workspace: string,
	amount: number,
	idempotencyKey: string,
	actor: Actor = ALICE,
): HarnessCall {
	return {
		actor,
		workspace,
		operation: "ledger.addEntry",
		input: { amount },
		idempotencyKey,
	};
}

function listingEntries(workspace: string): HarnessCall {
	return {
		actor: ALICE,
		workspace,
		operation: "ledger.listEntries",
		input: {},
	};
}

describe("a mutation called again with the same idempotency key", () => {
	test("runs once and answers the second call as it answered the first", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);

		const first = await harness.call(addingEntry(workspace, 42, "retry-1"));
		const second = await harness.call(addingEntry(workspace, 42, "retry-1"));

		expect(first).toEqual({
			ok: true,
			output: { id: expect.any(String), amount: 42 },
		});
		expect(second).toEqual(first);
		expect(await harness.call(listingEntries(workspace))).toEqual({
			ok: true,
			output: { entries: [{ id: expect.any(String), amount: 42 }] },
		});
	});
});

describe("a mutation called with an idempotency key already used", () => {
	type Workspaces = { readonly accounts: string; readonly payroll: string };

	test.each([
		{
			variant: "another input",
			operation: "ledger.addEntry",
			amount: 43,
			workspaceOf: (workspaces: Workspaces) => workspaces.accounts,
		},
		{
			variant: "another workspace",
			operation: "ledger.addEntry",
			amount: 42,
			workspaceOf: (workspaces: Workspaces) => workspaces.payroll,
		},
		{
			variant: "another operation",
			operation: "ledger.addEntryBehindLock",
			amount: 42,
			workspaceOf: (workspaces: Workspaces) => workspaces.accounts,
		},
	])(
		"is rejected with idempotency_key_reused for $variant and runs not",
		async ({ operation, amount, workspaceOf }) => {
			const harness = await startLedger();
			const accounts = await harness.createWorkspace("Accounts", MEMBERS);
			const payroll = await harness.createWorkspace("Payroll", MEMBERS);
			await harness.call(addingEntry(accounts, 42, "retry-1"));

			const again = await harness.call({
				...addingEntry(workspaceOf({ accounts, payroll }), amount, "retry-1"),
				operation,
			});

			expect(again).toEqual({
				ok: false,
				failure: {
					code: "idempotency_key_reused",
					kind: "rejected",
					detail:
						"the idempotency key was already used with another operation, workspace or input",
					issues: [],
				},
			});
			expect(await harness.call(listingEntries(accounts))).toEqual({
				ok: true,
				output: { entries: [{ id: expect.any(String), amount: 42 }] },
			});
			expect(await harness.call(listingEntries(payroll))).toEqual({
				ok: true,
				output: { entries: [] },
			});
		},
	);
});

describe("idempotency keys of different actors", () => {
	test.each([
		{ variant: "another user", other: BOB },
		{
			variant: "a service account of the same id",
			other: ALICE_AS_SERVICE_ACCOUNT,
		},
	])(
		"are kept apart, so $variant runs with the same key",
		async ({ other }) => {
			const harness = await startLedger();
			const workspace = await harness.createWorkspace("Accounts", MEMBERS);
			await harness.call(addingEntry(workspace, 42, "retry-1", ALICE));

			const others = await harness.call(
				addingEntry(workspace, 43, "retry-1", other),
			);

			expect(others).toEqual({
				ok: true,
				output: { id: expect.any(String), amount: 43 },
			});
			expect(await harness.call(listingEntries(workspace))).toEqual({
				ok: true,
				output: {
					entries: [
						{ id: expect.any(String), amount: 42 },
						{ id: expect.any(String), amount: 43 },
					],
				},
			});
		},
	);
});

describe("a mutation that failed with an idempotency key", () => {
	test("leaves the key free, so a retry with it runs", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		await harness.call(addingEntry(workspace, 0, "retry-1"));

		const retried = await harness.call(addingEntry(workspace, 5, "retry-1"));

		expect(retried).toEqual({
			ok: true,
			output: { id: expect.any(String), amount: 5 },
		});
	});
});

const MALFORMED_KEYS = [
	{ variant: "empty", key: "" },
	{ variant: "longer than 255 characters", key: "k".repeat(256) },
	{ variant: "with a control character", key: "retry\n1" },
	{ variant: "beyond ASCII", key: "wiederholung-ä" },
	{ variant: "with a comma", key: "retry,1" },
];

const LONGEST_KEY = `retry ~!+-${"k".repeat(245)}`;

describe("a malformed idempotency key", () => {
	test.each(MALFORMED_KEYS)(
		"is rejected with invalid_idempotency_key when $variant, and nothing runs",
		async ({ key }) => {
			const harness = await startLedger();
			const workspace = await harness.createWorkspace("Accounts", MEMBERS);

			const added = await harness.call(addingEntry(workspace, 42, key));

			expect(added).toEqual({
				ok: false,
				failure: {
					code: "invalid_idempotency_key",
					kind: "invalid_input",
					detail:
						"the idempotency key must consist of 1 to 255 visible ASCII characters or spaces, without a comma",
					issues: [],
				},
			});
			expect(await harness.call(listingEntries(workspace))).toEqual({
				ok: true,
				output: { entries: [] },
			});
		},
	);

	test("of 255 visible ASCII characters and spaces other than a comma is accepted", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);

		const added = await harness.call(addingEntry(workspace, 42, LONGEST_KEY));

		expect(added).toEqual({
			ok: true,
			output: { id: expect.any(String), amount: 42 },
		});
	});
});

describe("a query called with an idempotency key", () => {
	test("runs each time, since it changes nothing a retry could double", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		await harness.call({
			...listingEntries(workspace),
			idempotencyKey: "read-1",
		});
		await harness.call(addingEntry(workspace, 42, "retry-1"));

		const listed = await harness.call({
			...listingEntries(workspace),
			idempotencyKey: "read-1",
		});

		expect(listed).toEqual({
			ok: true,
			output: { entries: [{ id: expect.any(String), amount: 42 }] },
		});
	});

	test("runs with a key a mutation would reject as malformed, since a query takes no key", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);

		const listed = await harness.call({
			...listingEntries(workspace),
			idempotencyKey: "",
		});

		expect(listed).toEqual({ ok: true, output: { entries: [] } });
	});
});

function adjustableClock(start: string) {
	let current = new Date(start);
	return {
		now: () => current,
		advanceBy: (ms: number) => {
			current = new Date(current.getTime() + ms);
		},
	};
}

const ONE_MINUTE_MS = 60_000;

const ONE_DAY_MS = 86_400_000;

describe("an idempotency key", () => {
	test("holds for 24 hours, however often the due jobs run", async () => {
		const clock = adjustableClock("2026-11-27T09:00:30.000Z");
		const harness = await startLedger({ now: clock.now });
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		await harness.call(addingEntry(workspace, 42, "retry-1"));
		await harness.runJobs();
		clock.advanceBy(ONE_DAY_MS - ONE_MINUTE_MS);
		await harness.runJobs();
		await harness.runJobs();

		const again = await harness.call(addingEntry(workspace, 43, "retry-1"));

		expect(again).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "idempotency_key_reused" }),
		});
	});

	test("is removed by a cron job of the core once 24 hours have passed, so a call with it runs again", async () => {
		const clock = adjustableClock("2026-11-27T09:00:30.000Z");
		const harness = await startLedger({ now: clock.now });
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		await harness.call(addingEntry(workspace, 42, "retry-1"));
		await harness.runJobs();
		clock.advanceBy(ONE_DAY_MS + 10 * ONE_MINUTE_MS);
		await harness.runJobs();

		const again = await harness.call(addingEntry(workspace, 43, "retry-1"));

		expect(again).toEqual({
			ok: true,
			output: { id: expect.any(String), amount: 43 },
		});
	});
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const NOT_STOPPED = new AbortController().signal;

const WORKSPACE = "00000000-0000-4000-8000-00000000aaaa";

const CONCURRENT_CALLS = 3;

async function startLedgerPipeline(
	database: FreshDatabase,
	now: () => Date = () => new Date("2026-11-28T09:00:00.000Z"),
): Promise<OperationPipeline> {
	const { logger } = recordingLogger();
	const runner: MigrationRunner = {
		databaseUrl: new Secret(database.url),
		connectionTimeoutMs: 10_000,
		statementTimeoutMs: 60_000,
		lockRetryDelayMs: () => 0,
		setTimer: setSystemTimer,
		logger,
	};
	await migrateCoreSchema(runner, CORE_MIGRATIONS_DIRECTORY, NOT_STOPPED);
	const plugins = await startPlugins({
		discover: async () => ({ packages: [ledger], unreadable: [] }),
		enabledPlugins: ["ledger"],
		capabilityProviders: {},
		migrateSchemas: (schemas) => migrateSchemas(runner, schemas, NOT_STOPPED),
		hookTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
	cleanups.push(async () => {
		await plugins.deactivate();
	});
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Accounts",
		createdAt: now(),
	});
	await grantMembership(database.sql, {
		workspace: WORKSPACE,
		actor: ALICE,
		role: "owner",
		createdAt: new Date("2026-11-27T09:00:00.000Z"),
	});
	await grantMembership(database.sql, {
		workspace: WORKSPACE,
		actor: BOB,
		role: "owner",
		createdAt: new Date("2026-11-27T09:00:00.000Z"),
	});
	await grantMembership(database.sql, {
		workspace: WORKSPACE,
		actor: ALICE_AS_SERVICE_ACCOUNT,
		role: "owner",
		createdAt: new Date("2026-11-27T09:00:00.000Z"),
	});
	const pool = new SQL(database.url, { max: CONCURRENT_CALLS });
	cleanups.push(() => pool.close());
	return createOperationPipeline({
		sql: pool,
		registry: plugins.operations,
		events: plugins.events,
		jobs: plugins.jobs,
		now,
		newId: () => crypto.randomUUID(),
		newAuditEntryId: () => crypto.randomUUID(),
		newEventId: () => crypto.randomUUID(),
		newJobId: () => crypto.randomUUID(),
		eventsCommitted: () => {},
		jobsCommitted: () => {},
		random: () => 0.5,
		logger,
	});
}

async function startCoreJobQueue(
	database: FreshDatabase,
	now: () => Date,
): Promise<JobQueue> {
	await startLedgerPipeline(database, now);
	const { logger } = recordingLogger();
	return createJobQueue({
		sql: database.sql,
		cancellation: database.cancellation,
		jobs: registerJobs(CORE_JOBS),
		hasCoreSchema: () => true,
		now,
		newId: () => crypto.randomUUID(),
		newJobId: () => crypto.randomUUID(),
		random: () => 0.5,
		runTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
}

const MOST_REMOVED_PER_RUN = 10_000;

function insertingExpiredKeys(database: FreshDatabase, count: number) {
	return database.sql`
		INSERT INTO core.idempotency_keys (actor_kind, actor_id, key, operation, workspace_id, input_hash, created_at)
		SELECT 'user', 'alice', 'expired-' || n, 'ledger.addEntry', ${WORKSPACE}, ${"0".repeat(64)},
			'2026-11-26T09:00:00.000Z'::timestamptz + n * interval '1 millisecond'
		FROM generate_series(1, ${count}::integer) AS n`;
}

describe("the cron job removing expired idempotency keys", () => {
	test("removes at most 10 000 keys per run, the oldest first", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		const clock = adjustableClock("2026-11-27T09:00:30.000Z");
		const jobs = await startCoreJobQueue(database, clock.now);
		await insertingExpiredKeys(database, MOST_REMOVED_PER_RUN + 1);
		await jobs.runDue(NOT_STOPPED);
		clock.advanceBy(10 * ONE_MINUTE_MS);

		await jobs.runDue(NOT_STOPPED);

		expect(await database.sql`SELECT key FROM core.idempotency_keys`).toEqual([
			{ key: `expired-${MOST_REMOVED_PER_RUN + 1}` },
		]);
	});

	test("removes the keys left over on its next run", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		const clock = adjustableClock("2026-11-27T09:00:30.000Z");
		const jobs = await startCoreJobQueue(database, clock.now);
		await insertingExpiredKeys(database, MOST_REMOVED_PER_RUN + 1);
		await jobs.runDue(NOT_STOPPED);
		clock.advanceBy(10 * ONE_MINUTE_MS);
		await jobs.runDue(NOT_STOPPED);
		clock.advanceBy(10 * ONE_MINUTE_MS);

		await jobs.runDue(NOT_STOPPED);

		expect(await database.sql`SELECT key FROM core.idempotency_keys`).toEqual(
			[],
		);
	});
});

async function connectionHoldingTheEntryLock(
	database: FreshDatabase,
): Promise<SQL> {
	const connection = new SQL(database.url, { max: 1 });
	cleanups.push(() => connection.close());
	await connection`SELECT pg_advisory_lock(${ENTRY_LOCK})`;
	return connection;
}

async function untilSessionsWaitForALock(
	observer: SQL,
	count: number,
): Promise<void> {
	let waiting: unknown[] = [];
	while (waiting.length < count)
		waiting = await observer`
			SELECT FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`;
}

function addingEntryBehindTheLock(
	pipeline: OperationPipeline,
	amount: number,
	correlationId: string,
) {
	return pipeline.invoke({
		operation: "ledger.addEntryBehindLock",
		actor: ALICE,
		apiTokenId: null,
		idempotencyKey: "retry-1",
		workspace: WORKSPACE,
		input: { amount },
		correlationId,
	});
}

async function defaultingToIsolation(
	database: FreshDatabase,
	isolation: string,
): Promise<void> {
	const [{ name }] = z
		.tuple([z.object({ name: z.string() })])
		.parse(await database.sql`SELECT current_database() AS name`);
	await database.sql.unsafe(
		`ALTER DATABASE "${name}" SET default_transaction_isolation = '${isolation}'`,
	);
}

describe("two calls of a mutation with the same idempotency key at the same time", () => {
	test.each([
		{ isolation: "read committed" },
		{ isolation: "repeatable read" },
		{ isolation: "serializable" },
	])(
		"run it once, and the later answers as the earlier, when the database defaults to $isolation",
		async ({ isolation }) => {
			const database = await createFreshDatabase();
			cleanups.push(() => database.drop());
			await defaultingToIsolation(database, isolation);
			const pipeline = await startLedgerPipeline(database);
			const holder = await connectionHoldingTheEntryLock(database);

			const earlier = addingEntryBehindTheLock(pipeline, 42, "call-1");
			await untilSessionsWaitForALock(database.sql, 1);
			const later = addingEntryBehindTheLock(pipeline, 42, "call-2");
			await untilSessionsWaitForALock(database.sql, 2);
			await holder`SELECT pg_advisory_unlock(${ENTRY_LOCK})`;
			const answers = await Promise.all([earlier, later]);

			expect(answers[0]).toEqual({
				ok: true,
				output: { id: expect.any(String), amount: 42 },
			});
			expect(answers[1]).toEqual(answers[0]);
			expect(
				await database.sql`SELECT amount FROM plugin_ledger.entries`,
			).toEqual([{ amount: 42 }]);
		},
	);
});

describe("a call waiting for one with the same idempotency key but another input", () => {
	test("is rejected with idempotency_key_reused once the earlier has committed, and runs not", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		const pipeline = await startLedgerPipeline(database);
		const holder = await connectionHoldingTheEntryLock(database);

		const earlier = addingEntryBehindTheLock(pipeline, 42, "call-1");
		await untilSessionsWaitForALock(database.sql, 1);
		const later = addingEntryBehindTheLock(pipeline, 43, "call-2");
		await untilSessionsWaitForALock(database.sql, 2);
		await holder`SELECT pg_advisory_unlock(${ENTRY_LOCK})`;
		const answers = await Promise.all([earlier, later]);

		expect(answers).toEqual([
			{ ok: true, output: { id: expect.any(String), amount: 42 } },
			{
				ok: false,
				failure: expect.objectContaining({ code: "idempotency_key_reused" }),
			},
		]);
		expect(
			await database.sql`SELECT amount FROM plugin_ledger.entries`,
		).toEqual([{ amount: 42 }]);
	});
});

describe("a call waiting for one with the same idempotency key that fails", () => {
	test("runs the mutation itself once the failed call has rolled back", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		const pipeline = await startLedgerPipeline(database);
		const holder = await connectionHoldingTheEntryLock(database);

		const failing = addingEntryBehindTheLock(pipeline, 0, "call-1");
		await untilSessionsWaitForALock(database.sql, 1);
		const waiting = addingEntryBehindTheLock(pipeline, 5, "call-2");
		await untilSessionsWaitForALock(database.sql, 2);
		await holder`SELECT pg_advisory_unlock(${ENTRY_LOCK})`;
		const answers = await Promise.all([failing, waiting]);

		expect(answers).toEqual([
			{
				ok: false,
				failure: expect.objectContaining({ code: "ledger.zero_amount" }),
			},
			{ ok: true, output: { id: expect.any(String), amount: 5 } },
		]);
		expect(
			await database.sql`SELECT amount FROM plugin_ledger.entries`,
		).toEqual([{ amount: 5 }]);
	});
});

async function removingKeysCreatedBefore(
	database: FreshDatabase,
	createdBefore: string,
): Promise<void> {
	await database.sql.unsafe(`
		CREATE FUNCTION public.remove_keys_meanwhile() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			DELETE FROM core.idempotency_keys WHERE created_at < '${createdBefore}';
			RETURN NULL;
		END $$;
		CREATE TRIGGER remove_keys_meanwhile AFTER INSERT ON core.idempotency_keys
			FOR EACH STATEMENT EXECUTE FUNCTION public.remove_keys_meanwhile();
	`);
}

describe("an idempotency key removed between the claim that found it and its answer being read", () => {
	test("is claimed anew, so the call runs instead of failing", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		const clock = adjustableClock("2026-11-27T09:00:00.000Z");
		const pipeline = await startLedgerPipeline(database, clock.now);
		await addingEntryBehindTheLock(pipeline, 42, "call-1");
		clock.advanceBy(ONE_DAY_MS + ONE_MINUTE_MS);
		await removingKeysCreatedBefore(database, "2026-11-28T00:00:00.000Z");

		const again = await addingEntryBehindTheLock(pipeline, 43, "call-2");

		expect(again).toEqual({
			ok: true,
			output: { id: expect.any(String), amount: 43 },
		});
		expect(
			await database.sql`SELECT amount FROM plugin_ledger.entries ORDER BY amount`,
		).toEqual([{ amount: 42 }, { amount: 43 }]);
	});
});

function insertingKey(database: FreshDatabase, key: string) {
	return database.sql`
		INSERT INTO core.idempotency_keys (actor_kind, actor_id, key, operation, workspace_id, input_hash, created_at)
		VALUES ('user', 'alice', ${key}, 'ledger.addEntry', ${WORKSPACE}, ${"0".repeat(64)}, '2026-11-28T09:00:00.000Z')`;
}

describe("the table of idempotency keys", () => {
	test.each(MALFORMED_KEYS)(
		"refuses a key the pipeline rejects as $variant",
		async ({ key }) => {
			const database = await createFreshDatabase();
			cleanups.push(() => database.drop());
			await startLedgerPipeline(database);

			const inserted = insertingKey(database, key);

			await expect(inserted).rejects.toMatchObject({ errno: "23514" });
		},
	);

	test("keeps a key of 255 visible ASCII characters and spaces other than a comma, as the pipeline accepts it", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		await startLedgerPipeline(database);

		await insertingKey(database, LONGEST_KEY);

		expect(await database.sql`SELECT key FROM core.idempotency_keys`).toEqual([
			{ key: LONGEST_KEY },
		]);
	});
});
