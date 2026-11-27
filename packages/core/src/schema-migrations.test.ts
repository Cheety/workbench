import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { Secret } from "./config.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { createLogger, type Logger } from "./logger.ts";
import {
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "./schema-migrations.ts";
import { schemaName } from "./schema-name.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	PostgresGate,
} from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

const LOCK_HELD = "migration lock held by another run, waiting";

function announcingLogger(message: string) {
	const { promise, resolve } = Promise.withResolvers<void>();
	const logger = createLogger({
		level: "debug",
		now: () => new Date("2026-11-26T08:00:00.000Z"),
		write: (line) => {
			if (JSON.parse(line).message === message) resolve();
		},
	});
	return { logger, logged: promise };
}

const databases: FreshDatabase[] = [];

let openGate: PostgresGate | undefined;

const directories: string[] = [];

afterEach(async () => {
	openGate?.close();
	openGate = undefined;
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
	for (const database of databases.splice(0)) await database.drop();
});

async function freshDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	databases.push(database);
	return database;
}

const NOT_STOPPED = new AbortController().signal;

function runnerFor(url: string, logger: Logger): MigrationRunner {
	return {
		databaseUrl: new Secret(url),
		connectionTimeoutMs: 2_000,
		statementTimeoutMs: 5_000,
		lockRetryDelayMs: () => 10,
		setTimer: setSystemTimer,
		logger,
	};
}

async function coreMigrations(
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "workbench-core-migrations-"));
	directories.push(directory);
	for (const [name, sql] of Object.entries(files))
		await writeFile(join(directory, name), sql);
	return directory;
}

async function gatedMigration(database: FreshDatabase) {
	await database.sql.unsafe(`
		CREATE TABLE public.gate (id int PRIMARY KEY);
		INSERT INTO public.gate VALUES (1);
		CREATE TABLE public.applications (migration text NOT NULL);
	`);
	const holder = new SQL(database.url, { max: 1 });
	await holder.unsafe("BEGIN; SELECT id FROM public.gate FOR UPDATE;");
	return {
		migration: {
			name: "0001_wait_at_gate.sql",
			sql: "SELECT id FROM public.gate FOR UPDATE; INSERT INTO public.applications VALUES ('0001_wait_at_gate.sql');",
		},
		open: async () => {
			await holder.unsafe("COMMIT");
			await holder.close();
		},
	};
}

const NOTES = {
	schema: schemaName("plugin_notes"),
	migrations: [
		{
			name: "0001_create_notes.sql",
			sql: "CREATE TABLE notes (id bigint PRIMARY KEY, title text NOT NULL);",
		},
	],
};

describe("schema migrations", () => {
	test("create the core schema and each given schema with its tables on a fresh database", async () => {
		const database = await freshDatabase();
		const { logger } = recordingLogger();

		const run = await migrateSchemas(
			runnerFor(database.url, logger),
			[NOTES],
			NOT_STOPPED,
		);

		expect(run).toEqual({
			stopped: false,
			outcomes: [
				{
					schema: schemaName("plugin_notes"),
					migrated: true,
					applied: ["0001_create_notes.sql"],
				},
			],
		});
		expect(
			await database.sql`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('core', 'plugin_notes') ORDER BY table_schema, table_name`,
		).toEqual([
			{ table_schema: "core", table_name: "migrations" },
			{ table_schema: schemaName("plugin_notes"), table_name: "notes" },
		]);
	});

	test("apply nothing when every migration was applied before", async () => {
		const database = await freshDatabase();
		const url = database.url;
		await migrateSchemas(
			runnerFor(url, recordingLogger().logger),
			[NOTES],
			NOT_STOPPED,
		);
		const { logger, entries } = recordingLogger();

		const run = await migrateSchemas(
			runnerFor(url, logger),
			[NOTES],
			NOT_STOPPED,
		);

		expect(run).toEqual({
			stopped: false,
			outcomes: [
				{ schema: schemaName("plugin_notes"), migrated: true, applied: [] },
			],
		});
		expect(entries).not.toContainEqual(
			expect.objectContaining({ message: "migration applied" }),
		);
	});

	test("apply only the migrations added since the last run, in the order of their names", async () => {
		const database = await freshDatabase();
		const url = database.url;
		await migrateSchemas(
			runnerFor(url, recordingLogger().logger),
			[NOTES],
			NOT_STOPPED,
		);
		const { logger } = recordingLogger();

		const run = await migrateSchemas(
			runnerFor(url, logger),
			[
				{
					schema: schemaName("plugin_notes"),
					migrations: [
						{
							name: "0003_add_pinned.sql",
							sql: "ALTER TABLE notes ADD COLUMN pinned boolean NOT NULL DEFAULT false;",
						},
						...NOTES.migrations,
						{
							name: "0002_add_body.sql",
							sql: "ALTER TABLE notes ADD COLUMN body text;",
						},
					],
				},
			],
			NOT_STOPPED,
		);

		expect(run).toEqual({
			stopped: false,
			outcomes: [
				{
					schema: schemaName("plugin_notes"),
					migrated: true,
					applied: ["0002_add_body.sql", "0003_add_pinned.sql"],
				},
			],
		});
		expect(
			await database.sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'plugin_notes' AND table_name = 'notes' ORDER BY ordinal_position`,
		).toEqual([
			{ column_name: "id" },
			{ column_name: "title" },
			{ column_name: "body" },
			{ column_name: "pinned" },
		]);
	});

	test("roll back a failing migration, skip the rest of its schema, log it and still migrate the other schemas", async () => {
		const database = await freshDatabase();
		const { logger, entries } = recordingLogger();

		const run = await migrateSchemas(
			runnerFor(database.url, logger),
			[
				{
					schema: schemaName("plugin_board"),
					migrations: [
						{
							name: "0001_create_cards.sql",
							sql: "CREATE TABLE cards (id bigint PRIMARY KEY); CREATE TABLE cards (id bigint);",
						},
						{
							name: "0002_create_lanes.sql",
							sql: "CREATE TABLE lanes (id bigint PRIMARY KEY);",
						},
					],
				},
				NOTES,
			],
			NOT_STOPPED,
		);

		expect(run).toEqual({
			stopped: false,
			outcomes: [
				{
					schema: schemaName("plugin_board"),
					migrated: false,
					applied: [],
					detail:
						'migration "0001_create_cards.sql" of schema "plugin_board" failed (PostgresError: relation "cards" already exists)',
					error: expect.objectContaining({ name: "PostgresError" }),
				},
				{
					schema: schemaName("plugin_notes"),
					migrated: true,
					applied: ["0001_create_notes.sql"],
				},
			],
		});
		expect(
			await database.sql`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema LIKE 'plugin_%' ORDER BY table_schema`,
		).toEqual([
			{ table_schema: schemaName("plugin_notes"), table_name: "notes" },
		]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "migration failed",
				schema: schemaName("plugin_board"),
				migration: "0001_create_cards.sql",
			}),
		);
	});

	test("refuse a migration whose file name is no migration name: nothing of it stays, and the log says so", async () => {
		const database = await freshDatabase();
		const { logger, entries } = recordingLogger();

		const run = await migrateSchemas(
			runnerFor(database.url, logger),
			[
				{
					schema: schemaName("plugin_notes"),
					migrations: [
						{
							name: "create_notes.sql",
							sql: "CREATE TABLE notes (id bigint PRIMARY KEY);",
						},
					],
				},
			],
			NOT_STOPPED,
		);

		expect(run).toEqual({
			stopped: false,
			outcomes: [
				expect.objectContaining({
					schema: schemaName("plugin_notes"),
					migrated: false,
					applied: [],
				}),
			],
		});
		expect(
			await database.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'plugin_notes'`,
		).toEqual([]);
		expect(await database.sql`SELECT migration FROM core.migrations`).toEqual(
			[],
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "migration failed",
				schema: schemaName("plugin_notes"),
				migration: "create_notes.sql",
			}),
		);
	});

	test("report the outcome and log why the lock could not be released when the connection is lost during a migration", async () => {
		const database = await freshDatabase();
		const { logger, entries } = recordingLogger();

		const run = await migrateSchemas(
			runnerFor(database.url, logger),
			[
				{
					schema: schemaName("plugin_notes"),
					migrations: [
						{
							name: "0001_lose_connection.sql",
							sql: "SELECT pg_terminate_backend(pg_backend_pid());",
						},
					],
				},
			],
			NOT_STOPPED,
		);

		expect(run).toEqual({
			stopped: false,
			outcomes: [
				expect.objectContaining({
					schema: schemaName("plugin_notes"),
					migrated: false,
					applied: [],
				}),
			],
		});
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message: "migration lock not released",
				error: expect.objectContaining({ name: "PostgresError" }),
			}),
		);
	});

	test("give up connecting when the database does not answer within the connection timeout", async () => {
		const gate = PostgresGate.create();
		openGate = gate;
		gate.goSilent();
		const runner = {
			...runnerFor(gate.url, recordingLogger().logger),
			connectionTimeoutMs: 200,
		};

		const run = migrateSchemas(runner, [NOTES], NOT_STOPPED);

		await expect(run).rejects.toMatchObject({
			name: "PostgresError",
			code: "ERR_POSTGRES_CONNECTION_TIMEOUT",
		});
	});

	test("fail a migration that waits for a table lock longer than the statement timeout and free the migration lock", async () => {
		const database = await freshDatabase();
		await database.sql`CREATE TABLE public.archive (id int PRIMARY KEY)`;
		const blocker = new SQL(database.url, { max: 1 });
		await blocker.unsafe(
			"BEGIN; LOCK TABLE public.archive IN ACCESS EXCLUSIVE MODE;",
		);
		const readsArchive = {
			schema: schemaName("plugin_notes"),
			migrations: [
				{
					name: "0001_read_archive.sql",
					sql: "SELECT count(*) FROM public.archive;",
				},
			],
		};
		const { logger, entries } = recordingLogger();
		const runner: MigrationRunner = {
			...runnerFor(database.url, logger),
			statementTimeoutMs: 200,
		};

		const run = await migrateSchemas(runner, [readsArchive], NOT_STOPPED);

		await blocker.unsafe("COMMIT");
		await blocker.close();
		expect(run).toEqual({
			stopped: false,
			outcomes: [
				expect.objectContaining({
					schema: schemaName("plugin_notes"),
					migrated: false,
					applied: [],
					detail: expect.stringContaining("statement timeout"),
				}),
			],
		});
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "migration failed",
				migration: "0001_read_archive.sql",
			}),
		);
		expect(
			await database.sql`SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory'`,
		).toEqual([{ held: 0 }]);
	});

	test("stop waiting for the lock another run holds when it is told to stop", async () => {
		const database = await freshDatabase();
		const gate = await gatedMigration(database);
		const holding = migrateSchemas(
			runnerFor(database.url, recordingLogger().logger),
			[{ schema: schemaName("plugin_notes"), migrations: [gate.migration] }],
			NOT_STOPPED,
		);
		await untilBlockedSessions(database, 1);
		const stop = new AbortController();
		const { logger, entries } = recordingLogger();
		const runner: MigrationRunner = {
			...runnerFor(database.url, logger),
			setTimer: () => {
				queueMicrotask(() => stop.abort());
				return () => {};
			},
		};

		const run = await migrateSchemas(runner, [NOTES], stop.signal);

		await gate.open();
		await holding;
		expect(run).toEqual({ stopped: true });
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "info",
				message: LOCK_HELD,
			}),
		);
	});

	test("apply no further migration once it is told to stop", async () => {
		const database = await freshDatabase();
		const gate = await gatedMigration(database);
		const stop = new AbortController();

		const running = migrateSchemas(
			runnerFor(database.url, recordingLogger().logger),
			[
				{
					schema: schemaName("plugin_notes"),
					migrations: [
						gate.migration,
						...NOTES.migrations.map((migration) => ({
							...migration,
							name: "0002_create_notes.sql",
						})),
					],
				},
			],
			stop.signal,
		);
		await untilBlockedSessions(database, 1);
		stop.abort();
		await gate.open();
		const run = await running;

		expect(run).toEqual({ stopped: true });
		expect(await database.sql`SELECT migration FROM core.migrations`).toEqual([
			{ migration: "0001_wait_at_gate.sql" },
		]);
	});

	test("apply each migration exactly once when two runs start at the same time", async () => {
		const database = await freshDatabase();
		const gate = await gatedMigration(database);
		const gated = {
			schema: schemaName("plugin_notes"),
			migrations: [gate.migration],
		};
		await migrateSchemas(
			runnerFor(database.url, recordingLogger().logger),
			[{ schema: gated.schema, migrations: [] }],
			NOT_STOPPED,
		);
		const { logger, logged } = announcingLogger(LOCK_HELD);

		const runs = Promise.all([
			migrateSchemas(runnerFor(database.url, logger), [gated], NOT_STOPPED),
			migrateSchemas(runnerFor(database.url, logger), [gated], NOT_STOPPED),
		]);
		await untilBlockedSessions(database, 1);
		await logged;
		await gate.open();
		const results = await runs;

		expect(results).toContainAllValues([
			{
				stopped: false,
				outcomes: [
					{
						schema: schemaName("plugin_notes"),
						migrated: true,
						applied: ["0001_wait_at_gate.sql"],
					},
				],
			},
			{
				stopped: false,
				outcomes: [
					{ schema: schemaName("plugin_notes"), migrated: true, applied: [] },
				],
			},
		]);
		expect(
			await database.sql`SELECT migration FROM public.applications`,
		).toEqual([{ migration: "0001_wait_at_gate.sql" }]);
	});
});

const BLOCKED_SESSIONS_DEADLINE_MS = 2_000;

async function untilBlockedSessions(
	database: FreshDatabase,
	count: number,
): Promise<void> {
	const deadline = performance.now() + BLOCKED_SESSIONS_DEADLINE_MS;
	let blocked = 0;
	while (performance.now() < deadline) {
		const [row] =
			await database.sql`SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
		blocked = row.blocked;
		if (blocked >= count) return;
	}
	throw new Error(
		`expected ${count} sessions waiting for a lock within ${BLOCKED_SESSIONS_DEADLINE_MS} ms, saw ${blocked}`,
	);
}

describe("core schema migrations", () => {
	test("apply the migrations of the core schema from its directory", async () => {
		const database = await freshDatabase();
		const directory = await coreMigrations({
			"0001_create_settings.sql":
				"CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);",
		});

		const outcome = await migrateCoreSchema(
			runnerFor(database.url, recordingLogger().logger),
			directory,
			NOT_STOPPED,
		);

		expect(outcome).toBe("migrated");
		expect(
			await database.sql`SELECT schema_name, migration FROM core.migrations`,
		).toEqual([{ schema_name: "core", migration: "0001_create_settings.sql" }]);
		expect(
			await database.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' ORDER BY table_name`,
		).toEqual([{ table_name: "migrations" }, { table_name: "settings" }]);
	});

	test("migrate the core schema when its directory holds no migration", async () => {
		const database = await freshDatabase();

		const outcome = await migrateCoreSchema(
			runnerFor(database.url, recordingLogger().logger),
			await coreMigrations({}),
			NOT_STOPPED,
		);

		expect(outcome).toBe("migrated");
	});

	test("report the core schema as not migrated when one of its migrations fails", async () => {
		const database = await freshDatabase();
		const directory = await coreMigrations({
			"0001_broken.sql": "CREATE TABLE settings (;",
		});

		const outcome = await migrateCoreSchema(
			runnerFor(database.url, recordingLogger().logger),
			directory,
			NOT_STOPPED,
		);

		expect(outcome).toBe("not_migrated");
	});

	test("report a stopped run when it is told to stop beforehand", async () => {
		const database = await freshDatabase();
		const stop = new AbortController();
		stop.abort();

		const outcome = await migrateCoreSchema(
			runnerFor(database.url, recordingLogger().logger),
			await coreMigrations({}),
			stop.signal,
		);

		expect(outcome).toBe("stopped");
	});
});
