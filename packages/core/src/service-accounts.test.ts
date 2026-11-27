import { afterEach, describe, expect, test } from "bun:test";
import { authenticateToken } from "./api-tokens.ts";
import { Secret } from "./config.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	migrateCoreSchema,
} from "./schema-migrations.ts";
import {
	createServiceAccount,
	InvalidValidDaysError,
} from "./service-accounts.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

const NOW = new Date("2026-11-26T08:00:00.000Z");

const THIRTY_DAYS_LATER = new Date("2026-12-26T08:00:00.000Z");

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

const sources = {
	now: () => NOW,
	newId: () => crypto.randomUUID(),
	newToken: () => new Secret("wbt_test-token"),
};

describe("creating a service account", () => {
	test("issues a token that expires the given number of days after creation", async () => {
		const database = await migratedDatabase();

		const issued = await createServiceAccount(
			database.sql,
			{ name: "deploy agent", validDays: 30 },
			sources,
		);

		expect(issued).toEqual({
			serviceAccountId: expect.any(String),
			token: expect.any(Secret),
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
			actor: { kind: "service_account", id: issued.serviceAccountId },
		});
		expect(
			await authenticateToken(
				database.sql,
				"wbt_test-token",
				THIRTY_DAYS_LATER,
			),
		).toEqual({ authenticated: false, reason: "expired_token" });
	});

	test("issues a token that neither serializing nor stringifying reveals", async () => {
		const database = await migratedDatabase();

		const issued = await createServiceAccount(
			database.sql,
			{ name: "deploy agent", validDays: 30 },
			sources,
		);

		expect(`${JSON.stringify(issued)} ${String(issued.token)}`).not.toContain(
			"wbt_test-token",
		);
	});

	test("accepts a validity of the maximum of 3650 days", async () => {
		const database = await migratedDatabase();

		const issued = await createServiceAccount(
			database.sql,
			{ name: "deploy agent", validDays: 3650 },
			sources,
		);

		expect(issued.expiresAt).toEqual(new Date("2036-11-23T08:00:00.000Z"));
	});

	test.each([
		{ case: "zero days", validDays: 0 },
		{ case: "a negative number of days", validDays: -1 },
		{ case: "a fraction of a day", validDays: 1.5 },
		{ case: "more than 3650 days", validDays: 3651 },
		{ case: "no number", validDays: Number.NaN },
	])(
		"rejects a validity of $case and stores no service account",
		async ({ validDays }) => {
			const database = await migratedDatabase();

			const creating = createServiceAccount(
				database.sql,
				{ name: "deploy agent", validDays },
				sources,
			);

			await expect(creating).rejects.toBeInstanceOf(InvalidValidDaysError);
			expect(await database.sql`SELECT id FROM core.service_accounts`).toEqual(
				[],
			);
		},
	);
});
