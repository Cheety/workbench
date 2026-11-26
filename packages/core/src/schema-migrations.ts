import { type ReservedSQL, SQL } from "bun";
import type { Secret } from "./config.ts";
import { pauseUnlessStopped } from "./database-wait.ts";
import {
	describeThrown,
	summarize,
	type ThrownError,
} from "./failure-reason.ts";
import type { SetTimer } from "./hook-timeout.ts";
import type { Logger } from "./logger.ts";
import { readMigrations } from "./migration-files.ts";
import { quote } from "./quote.ts";
import { type SchemaName, schemaName } from "./schema-name.ts";

export type Migration = {
	readonly name: string;
	readonly sql: string;
};

export type SchemaMigrations = {
	readonly schema: SchemaName;
	readonly migrations: readonly Migration[];
};

export type SchemaMigrationOutcome =
	| {
			readonly schema: SchemaName;
			readonly migrated: true;
			readonly applied: readonly string[];
	  }
	| {
			readonly schema: SchemaName;
			readonly migrated: false;
			readonly applied: readonly string[];
			readonly detail: string;
			readonly error?: ThrownError;
	  };

export type MigrationRun =
	| {
			readonly stopped: false;
			readonly outcomes: readonly SchemaMigrationOutcome[];
	  }
	| { readonly stopped: true };

export type MigrationRunner = {
	readonly databaseUrl: Secret;
	readonly connectionTimeoutMs: number;
	readonly lockRetryDelayMs: (attempt: number) => number;
	readonly setTimer: SetTimer;
	readonly logger: Logger;
};

const MIGRATION_LOCK_KEY = 0x776f726b62656e63n;

const STOPPED: MigrationRun = { stopped: true };

const CORE_SCHEMA = schemaName("core");

export type CoreSchemaMigration = "migrated" | "not_migrated" | "stopped";

export async function migrateCoreSchema(
	runner: MigrationRunner,
	migrationsDirectory: string,
	stopSignal: AbortSignal,
): Promise<CoreSchemaMigration> {
	const migrations = await readMigrations(migrationsDirectory);
	const run = await migrateSchemas(
		runner,
		[{ schema: CORE_SCHEMA, migrations }],
		stopSignal,
	);
	if (run.stopped) return "stopped";
	const migrated = run.outcomes.some(
		(outcome) => outcome.schema === CORE_SCHEMA && outcome.migrated,
	);
	return migrated ? "migrated" : "not_migrated";
}

export async function migrateSchemas(
	runner: MigrationRunner,
	schemas: readonly SchemaMigrations[],
	stopSignal: AbortSignal,
): Promise<MigrationRun> {
	if (stopSignal.aborted) return STOPPED;
	const { logger } = runner;
	const sql = new SQL(runner.databaseUrl.reveal(), {
		max: 1,
		connectionTimeout: runner.connectionTimeoutMs / 1000,
	});
	try {
		const connection = await sql.reserve();
		try {
			const lock = await acquireLock(connection, runner, stopSignal);
			if (lock === "stopped") return STOPPED;
			try {
				await createMigrationsTable(connection);
				const outcomes: SchemaMigrationOutcome[] = [];
				for (const schema of schemas) {
					const outcome = await migrateSchema(
						connection,
						schema,
						logger,
						stopSignal,
					);
					if (outcome === "stopped") return STOPPED;
					outcomes.push(outcome);
				}
				return { stopped: false, outcomes };
			} finally {
				await releaseLock(connection, logger);
			}
		} finally {
			connection.release();
		}
	} finally {
		await sql.close();
	}
}

async function acquireLock(
	connection: ReservedSQL,
	{ lockRetryDelayMs, setTimer, logger }: MigrationRunner,
	stopSignal: AbortSignal,
): Promise<"acquired" | "stopped"> {
	for (let attempt = 0; !stopSignal.aborted; attempt += 1) {
		const [row]: { acquired: boolean }[] =
			await connection`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) AS acquired`;
		if (row?.acquired) return "acquired";
		if (attempt === 0)
			logger.info("migration lock held by another run, waiting");
		await pauseUnlessStopped(lockRetryDelayMs(attempt), setTimer, stopSignal);
	}
	return "stopped";
}

async function releaseLock(
	connection: ReservedSQL,
	logger: Logger,
): Promise<void> {
	try {
		await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
	} catch (error) {
		logger.warn("migration lock not released", {
			error: describeThrown(error),
		});
	}
}

async function createMigrationsTable(connection: ReservedSQL): Promise<void> {
	await connection.unsafe(`
		CREATE SCHEMA IF NOT EXISTS core;
		CREATE TABLE IF NOT EXISTS core.migrations (
			schema_name text NOT NULL,
			migration text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (schema_name, migration)
		);
	`);
}

async function migrateSchema(
	connection: ReservedSQL,
	{ schema, migrations }: SchemaMigrations,
	logger: Logger,
	stopSignal: AbortSignal,
): Promise<SchemaMigrationOutcome | "stopped"> {
	await connection.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
	const alreadyApplied = await appliedMigrations(connection, schema);
	const pending = migrations
		.filter((migration) => !alreadyApplied.has(migration.name))
		.toSorted((a, b) => compareNames(a.name, b.name));
	const applied: string[] = [];
	for (const migration of pending) {
		if (stopSignal.aborted) return "stopped";
		try {
			await connection.begin(async (transaction) => {
				await transaction.unsafe(`SET LOCAL search_path TO "${schema}"`);
				await transaction.unsafe(migration.sql);
				await transaction`INSERT INTO core.migrations (schema_name, migration) VALUES (${schema}, ${migration.name})`;
			});
		} catch (error) {
			const thrown = describeThrown(error);
			const detail = `migration ${quote(migration.name)} of schema ${quote(schema)} failed (${summarize(thrown)})`;
			logger.error("migration failed", {
				schema,
				migration: migration.name,
				detail,
				error: thrown,
			});
			return {
				schema,
				migrated: false,
				applied,
				detail,
				error: thrown,
			};
		}
		logger.info("migration applied", { schema, migration: migration.name });
		applied.push(migration.name);
	}
	return { schema, migrated: true, applied };
}

async function appliedMigrations(
	connection: ReservedSQL,
	schema: SchemaName,
): Promise<ReadonlySet<string>> {
	const rows: { migration: string }[] =
		await connection`SELECT migration FROM core.migrations WHERE schema_name = ${schema}`;
	return new Set(rows.map((row) => row.migration));
}

function compareNames(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
