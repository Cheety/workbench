import { afterEach, describe, expect, test } from "bun:test";
import { authenticateToken } from "./api-tokens.ts";
import { Secret } from "./config.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	migrateCoreSchema,
} from "./schema-migrations.ts";
import { createServiceAccount } from "./service-accounts.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

const NOW = new Date("2026-11-26T08:00:00.000Z");

const THIRTY_DAYS_LATER = new Date("2026-12-26T08:00:00.000Z");

const SERVICE_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

const databases: FreshDatabase[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) await database.drop();
});

async function migratedDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	databases.push(database);
	await migrateCoreSchema(
		{
			databaseUrl: new Secret(database.url),
			connectionTimeoutMs: 10_000,
			statementTimeoutMs: 60_000,
			lockRetryDelayMs: () => 0,
			setTimer: setSystemTimer,
			logger: recordingLogger().logger,
		},
		CORE_MIGRATIONS_DIRECTORY,
		new AbortController().signal,
	);
	return database;
}

describe("creating a service account", () => {
	test("issues a token that expires the given number of days after creation", async () => {
		const database = await migratedDatabase();
		const ids = [SERVICE_ACCOUNT_ID, "00000000-0000-4000-8000-000000000002"];

		const issued = await createServiceAccount(
			database.sql,
			{ name: "deploy agent", validDays: 30 },
			{
				now: () => NOW,
				newId: () => ids.shift() ?? "",
				newToken: () => "wbt_test-token",
			},
		);

		expect(issued).toEqual({
			serviceAccountId: SERVICE_ACCOUNT_ID,
			token: "wbt_test-token",
			expiresAt: THIRTY_DAYS_LATER,
		});
		expect(
			await authenticateToken(
				database.sql,
				"wbt_test-token",
				new Date(THIRTY_DAYS_LATER.getTime() - 1),
			),
		).toEqual({
			authenticated: true,
			actor: { kind: "service_account", id: SERVICE_ACCOUNT_ID },
		});
		expect(
			await authenticateToken(
				database.sql,
				"wbt_test-token",
				THIRTY_DAYS_LATER,
			),
		).toEqual({ authenticated: false, reason: "expired_token" });
	});
});
