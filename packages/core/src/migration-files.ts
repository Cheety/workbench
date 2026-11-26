import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { quote } from "./quote.ts";
import type { Migration } from "./schema-migrations.ts";

const SQL_FILE = ".sql";

// Postgres enforces it as well, on core.migrations, so it must mean the same in both regex dialects.
export const MIGRATION_FILE_NAME_PATTERN = "^[0-9]{4}_[a-z0-9_]+\\.sql$";

const MIGRATION_FILE_NAME = new RegExp(MIGRATION_FILE_NAME_PATTERN);

export class InvalidMigrationFileNameError extends Error {
	constructor(fileName: string) {
		super(
			`migration file ${quote(fileName)} must be named like "0001_initial_schema.sql": four digits, an underscore, lowercase letters, digits and underscores, ".sql"`,
		);
		this.name = "InvalidMigrationFileNameError";
	}
}

export async function readMigrations(
	directory: string,
): Promise<readonly Migration[]> {
	const names = (await readdir(directory))
		.filter((name) => name.endsWith(SQL_FILE))
		.sort();
	const misnamed = names.find((name) => !MIGRATION_FILE_NAME.test(name));
	if (misnamed !== undefined) throw new InvalidMigrationFileNameError(misnamed);
	return Promise.all(
		names.map(async (name) => ({
			name,
			sql: await Bun.file(join(directory, name)).text(),
		})),
	);
}
