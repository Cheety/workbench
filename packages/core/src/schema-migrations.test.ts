import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Secret } from "./config.ts";
import { createLogger } from "./logger.ts";
import { migrateSchemas } from "./schema-migrations.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";

type LogEntry = Record<string, unknown>;

function recordingLogger() {
	const entries: LogEntry[] = [];
	const logger = createLogger({
		level: "debug",
		now: () => new Date("2026-11-26T08:00:00.000Z"),
		write: (line) => entries.push(JSON.parse(line)),
	});
	return { logger, entries };
}

const databases: FreshDatabase[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) await database.drop();
});

async function freshDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	databases.push(database);
	return database;
}

const NOTES = {
	schema: "plugin_notes",
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

		const outcomes = await migrateSchemas(
			new Secret(database.url),
			[NOTES],
			logger,
		);

		expect(outcomes).toEqual([
			{
				schema: "plugin_notes",
				migrated: true,
				applied: ["0001_create_notes.sql"],
			},
		]);
		expect(
			await database.sql`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('core', 'plugin_notes') ORDER BY table_schema, table_name`,
		).toEqual([
			{ table_schema: "core", table_name: "migrations" },
			{ table_schema: "plugin_notes", table_name: "notes" },
		]);
	});

	test("apply nothing when every migration was applied before", async () => {
		const database = await freshDatabase();
		const url = new Secret(database.url);
		await migrateSchemas(url, [NOTES], recordingLogger().logger);
		const { logger, entries } = recordingLogger();

		const outcomes = await migrateSchemas(url, [NOTES], logger);

		expect(outcomes).toEqual([
			{ schema: "plugin_notes", migrated: true, applied: [] },
		]);
		expect(entries).toEqual([]);
	});

	test("apply only the migrations added since the last run, in the order of their names", async () => {
		const database = await freshDatabase();
		const url = new Secret(database.url);
		await migrateSchemas(url, [NOTES], recordingLogger().logger);
		const { logger } = recordingLogger();

		const outcomes = await migrateSchemas(
			url,
			[
				{
					schema: "plugin_notes",
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
			logger,
		);

		expect(outcomes).toEqual([
			{
				schema: "plugin_notes",
				migrated: true,
				applied: ["0002_add_body.sql", "0003_add_pinned.sql"],
			},
		]);
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

		const outcomes = await migrateSchemas(
			new Secret(database.url),
			[
				{
					schema: "plugin_board",
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
			logger,
		);

		expect(outcomes).toEqual([
			{
				schema: "plugin_board",
				migrated: false,
				applied: [],
				detail:
					'migration "0001_create_cards.sql" of schema "plugin_board" failed (PostgresError: relation "cards" already exists)',
				error: expect.objectContaining({ name: "PostgresError" }),
			},
			{
				schema: "plugin_notes",
				migrated: true,
				applied: ["0001_create_notes.sql"],
			},
		]);
		expect(
			await database.sql`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema LIKE 'plugin_%' ORDER BY table_schema`,
		).toEqual([{ table_schema: "plugin_notes", table_name: "notes" }]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "migration failed",
				schema: "plugin_board",
				migration: "0001_create_cards.sql",
			}),
		);
	});

	test.each([
		["longer than Postgres keeps", `plugin_${"a".repeat(57)}`],
		["not a plain lowercase identifier", 'plugin_x"; DROP SCHEMA core; --'],
	])(
		"reject a schema name %s without touching the database",
		async (_, schema) => {
			const database = await freshDatabase();
			const { logger } = recordingLogger();

			const [outcome] = await migrateSchemas(
				new Secret(database.url),
				[{ schema, migrations: NOTES.migrations }],
				logger,
			);

			expect(outcome).toMatchObject({
				schema,
				migrated: false,
				applied: [],
				detail: `schema name ${JSON.stringify(schema)} must consist of at most 63 lowercase letters, digits and underscores and start with a letter`,
			});
			expect(
				await database.sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'plugin_%'`,
			).toEqual([]);
		},
	);

	test("apply each migration exactly once when two runs start at the same time", async () => {
		const database = await freshDatabase();
		const url = new Secret(database.url);
		await database.sql.unsafe(`
			CREATE TABLE public.gate (id int PRIMARY KEY);
			INSERT INTO public.gate VALUES (1);
			CREATE TABLE public.applications (migration text NOT NULL);
		`);
		const gated = {
			schema: "plugin_notes",
			migrations: [
				{
					name: "0001_wait_at_gate.sql",
					sql: "SELECT id FROM public.gate FOR UPDATE; INSERT INTO public.applications VALUES ('0001_wait_at_gate.sql');",
				},
			],
		};
		await migrateSchemas(url, [], recordingLogger().logger);
		const holder = new SQL(database.url, { max: 1 });
		await holder.unsafe("BEGIN; SELECT id FROM public.gate FOR UPDATE;");
		const { logger } = recordingLogger();

		const runs = Promise.all([
			migrateSchemas(url, [gated], logger),
			migrateSchemas(url, [gated], logger),
		]);
		await untilBlockedSessions(database, 2);
		await holder.unsafe("COMMIT");
		await holder.close();
		const outcomes = await runs;

		expect(
			outcomes.flat().map((outcome) => outcome.applied),
		).toContainAllValues([["0001_wait_at_gate.sql"], []]);
		expect(
			await database.sql`SELECT migration FROM public.applications`,
		).toEqual([{ migration: "0001_wait_at_gate.sql" }]);
	});
});

async function untilBlockedSessions(
	database: FreshDatabase,
	count: number,
): Promise<void> {
	for (;;) {
		const [row] =
			await database.sql`SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
		if (row.blocked >= count) return;
	}
}
