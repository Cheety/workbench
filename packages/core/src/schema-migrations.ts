import { type ReservedSQL, SQL } from "bun";
import type { Secret } from "./config.ts";
import {
	describeThrown,
	summarize,
	type ThrownError,
} from "./failure-reason.ts";
import type { Logger } from "./logger.ts";
import { quote } from "./quote.ts";

export type Migration = {
	readonly name: string;
	readonly sql: string;
};

export type SchemaMigrations = {
	readonly schema: string;
	readonly migrations: readonly Migration[];
};

export type SchemaMigrationOutcome =
	| {
			readonly schema: string;
			readonly migrated: true;
			readonly applied: readonly string[];
	  }
	| {
			readonly schema: string;
			readonly migrated: false;
			readonly applied: readonly string[];
			readonly detail: string;
			readonly error?: ThrownError;
	  };

const MIGRATION_LOCK_KEY = 0x776f726b62656e63n;

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export async function migrateSchemas(
	databaseUrl: Secret,
	schemas: readonly SchemaMigrations[],
	logger: Logger,
): Promise<readonly SchemaMigrationOutcome[]> {
	const sql = new SQL(databaseUrl.reveal(), { max: 1 });
	try {
		const connection = await sql.reserve();
		try {
			await connection`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
			try {
				await createMigrationsTable(connection);
				const outcomes: SchemaMigrationOutcome[] = [];
				for (const schema of schemas)
					outcomes.push(await migrateSchema(connection, schema, logger));
				return outcomes;
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
): Promise<SchemaMigrationOutcome> {
	if (!SCHEMA_NAME.test(schema)) {
		const detail = `schema name ${quote(schema)} must consist of at most 63 lowercase letters, digits and underscores and start with a letter`;
		logger.error("schema not migrated", { schema, detail });
		return { schema, migrated: false, applied: [], detail };
	}
	await connection.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
	const alreadyApplied = await appliedMigrations(connection, schema);
	const pending = migrations
		.filter((migration) => !alreadyApplied.has(migration.name))
		.toSorted((a, b) => compareNames(a.name, b.name));
	const applied: string[] = [];
	for (const migration of pending) {
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
	schema: string,
): Promise<ReadonlySet<string>> {
	const rows: { migration: string }[] =
		await connection`SELECT migration FROM core.migrations WHERE schema_name = ${schema}`;
	return new Set(rows.map((row) => row.migration));
}

function compareNames(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
