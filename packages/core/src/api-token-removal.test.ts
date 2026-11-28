import { afterEach, describe, expect, test } from "bun:test";
import { apiTokenHash, authenticateToken } from "./api-tokens.ts";
import { Secret } from "./config.ts";
import { CORE_JOBS } from "./core-jobs.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { createJobQueue, type JobQueue } from "./job-queue.ts";
import { registerJobs } from "./job-registry.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	migrateCoreSchema,
} from "./schema-migrations.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

const NOT_STOPPED = new AbortController().signal;

const ONE_HOUR_MS = 3_600_000;

const ONE_DAY_MS = 86_400_000;

const STARTED_AT = new Date("2026-11-28T09:00:30.000Z");

const SERVICE_ACCOUNT = "00000000-0000-4000-8000-00000000cccc";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function adjustableClock(start: Date) {
	let current = start;
	return {
		now: () => current,
		advanceBy: (ms: number) => {
			current = new Date(current.getTime() + ms);
		},
	};
}

type Clock = ReturnType<typeof adjustableClock>;

type CoreJobs = {
	readonly database: FreshDatabase;
	readonly clock: Clock;
	readonly jobs: JobQueue;
};

async function startCoreJobs(): Promise<CoreJobs> {
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	const { logger } = recordingLogger();
	await migrateCoreSchema(
		{
			databaseUrl: new Secret(database.url),
			connectionTimeoutMs: 10_000,
			statementTimeoutMs: 60_000,
			lockRetryDelayMs: () => 0,
			setTimer: setSystemTimer,
			logger,
		},
		CORE_MIGRATIONS_DIRECTORY,
		NOT_STOPPED,
	);
	await database.sql`
		INSERT INTO core.service_accounts (id, name, created_at)
		VALUES (${SERVICE_ACCOUNT}, 'Agent', '2026-01-01T00:00:00.000Z')`;
	const clock = adjustableClock(STARTED_AT);
	const jobs = createJobQueue({
		sql: database.sql,
		cancellation: database.cancellation,
		jobs: registerJobs(CORE_JOBS),
		hasCoreSchema: () => true,
		now: clock.now,
		newId: () => crypto.randomUUID(),
		newJobId: () => crypto.randomUUID(),
		random: () => 0.5,
		runTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
	await jobs.runDue(NOT_STOPPED);
	return { database, clock, jobs };
}

async function runTheNextHour(core: CoreJobs): Promise<void> {
	core.clock.advanceBy(ONE_HOUR_MS);
	await core.jobs.runDue(NOT_STOPPED);
}

type StoredToken = {
	readonly id: string;
	readonly expiresAt: Date;
	readonly revokedAt: Date | null;
	readonly createdBy: string | null;
};

function daysBefore(days: number): Date {
	return new Date(STARTED_AT.getTime() - days * ONE_DAY_MS);
}

function daysAfter(days: number): Date {
	return new Date(STARTED_AT.getTime() + days * ONE_DAY_MS);
}

async function storeToken(
	database: FreshDatabase,
	token: StoredToken,
): Promise<void> {
	await database.sql`
		INSERT INTO core.api_tokens (id, service_account_id, token_hash, created_at, expires_at, revoked_at, created_by_api_token_id)
		VALUES (${token.id}, ${SERVICE_ACCOUNT}, ${apiTokenHash(`wbt_${token.id}`)}, '2026-01-01T00:00:00.000Z',
			${token.expiresAt}, ${token.revokedAt}, ${token.createdBy})`;
}

async function storedTokenIds(database: FreshDatabase): Promise<string[]> {
	const rows: { id: string }[] =
		await database.sql`SELECT id FROM core.api_tokens ORDER BY id`;
	return rows.map((row) => row.id);
}

const FIRST = "00000000-0000-4000-8000-000000000001";

const SECOND = "00000000-0000-4000-8000-000000000002";

const THIRD = "00000000-0000-4000-8000-000000000003";

describe("the cron job removing revoked and expired API tokens", () => {
	test("removes a token that expired more than 30 days ago", async () => {
		const core = await startCoreJobs();
		await storeToken(core.database, {
			id: FIRST,
			expiresAt: daysBefore(31),
			revokedAt: null,
			createdBy: null,
		});

		await runTheNextHour(core);

		expect(await storedTokenIds(core.database)).toEqual([]);
	});

	test("removes a token revoked more than 30 days ago, even before it expires", async () => {
		const core = await startCoreJobs();
		await storeToken(core.database, {
			id: FIRST,
			expiresAt: daysAfter(300),
			revokedAt: daysBefore(31),
			createdBy: null,
		});

		await runTheNextHour(core);

		expect(await storedTokenIds(core.database)).toEqual([]);
	});

	test.each([
		["one that expired 29 days ago", daysBefore(29), null],
		["one revoked 29 days ago", daysAfter(300), daysBefore(29)],
		["one neither revoked nor expired", daysAfter(1), null],
	])("keeps %s", async (_case, expiresAt, revokedAt) => {
		const core = await startCoreJobs();
		await storeToken(core.database, {
			id: FIRST,
			expiresAt,
			revokedAt,
			createdBy: null,
		});

		await runTheNextHour(core);

		expect(await storedTokenIds(core.database)).toEqual([FIRST]);
	});

	test("keeps a token revoked long ago while a token created with it is still valid on its own, so that one stays rejected", async () => {
		const core = await startCoreJobs();
		await storeToken(core.database, {
			id: FIRST,
			expiresAt: daysAfter(300),
			revokedAt: daysBefore(31),
			createdBy: null,
		});
		await storeToken(core.database, {
			id: SECOND,
			expiresAt: daysAfter(300),
			revokedAt: null,
			createdBy: FIRST,
		});
		await storeToken(core.database, {
			id: THIRD,
			expiresAt: daysBefore(31),
			revokedAt: null,
			createdBy: null,
		});

		await runTheNextHour(core);

		expect({
			stored: await storedTokenIds(core.database),
			descendant: await authenticateToken(
				core.database.sql,
				`wbt_${SECOND}`,
				core.clock.now(),
			),
		}).toEqual({
			stored: [FIRST, SECOND],
			descendant: { authenticated: false, reason: "revoked_token" },
		});
	});

	test("removes a token and the token created with it once both are settled", async () => {
		const core = await startCoreJobs();
		await storeToken(core.database, {
			id: FIRST,
			expiresAt: daysAfter(300),
			revokedAt: daysBefore(31),
			createdBy: null,
		});
		await storeToken(core.database, {
			id: SECOND,
			expiresAt: daysAfter(300),
			revokedAt: daysBefore(31),
			createdBy: FIRST,
		});
		await runTheNextHour(core);

		await runTheNextHour(core);

		expect(await storedTokenIds(core.database)).toEqual([]);
	});

	test("removes a token an audit entry names, which keeps naming it", async () => {
		const core = await startCoreJobs();
		await storeToken(core.database, {
			id: FIRST,
			expiresAt: daysBefore(31),
			revokedAt: null,
			createdBy: null,
		});
		await core.database.sql`
			INSERT INTO core.audit_entries (id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason)
			VALUES ('00000000-0000-4000-a000-000000000001', '2026-01-02T00:00:00.000Z', 'service_account', ${SERVICE_ACCOUNT},
				${FIRST}, 'core.defineRole', NULL, 'denied', 'not_instance_admin')`;

		await runTheNextHour(core);

		expect({
			stored: await storedTokenIds(core.database),
			audited: await core.database
				.sql`SELECT api_token_id FROM core.audit_entries`,
		}).toEqual({ stored: [], audited: [{ api_token_id: FIRST }] });
	});

	test("removes at most 1000 tokens per run and the rest on its next run", async () => {
		const core = await startCoreJobs();
		await core.database.sql`
			INSERT INTO core.api_tokens (id, service_account_id, token_hash, created_at, expires_at)
			SELECT gen_random_uuid(), ${SERVICE_ACCOUNT}, encode(sha256(n::text::bytea), 'hex'), '2026-01-01T00:00:00.000Z', ${daysBefore(31)}
			FROM generate_series(1, 1001) AS n`;
		await runTheNextHour(core);
		const leftAfterOneRun = await storedTokenIds(core.database);

		await runTheNextHour(core);

		expect({
			leftAfterOneRun: leftAfterOneRun.length,
			leftAfterTwoRuns: await storedTokenIds(core.database),
		}).toEqual({ leftAfterOneRun: 1, leftAfterTwoRuns: [] });
	});
});
