import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
	assertSupportedPostgresVersion,
	PostgresGate,
	UnsupportedPostgresVersionError,
} from "./postgres.ts";

const CLIENT_STATEMENT_TIMEOUT_MS = 200;

describe("supported Postgres version", () => {
	test.each([170000, 170002, 179999])(
		"accepts a server reporting server_version_num %d",
		(serverVersionNum) => {
			expect(() =>
				assertSupportedPostgresVersion(serverVersionNum),
			).not.toThrow();
		},
	);

	test.each([
		[160004, 16],
		[169999, 16],
		[180000, 18],
		[90624, 9],
	])(
		"rejects a server reporting server_version_num %d as Postgres %d",
		(serverVersionNum, major) => {
			const assert = () => assertSupportedPostgresVersion(serverVersionNum);

			expect(assert).toThrow(UnsupportedPostgresVersionError);
			expect(assert).toThrow(
				`test database runs Postgres ${major} (server_version_num ${serverVersionNum}), tests need Postgres 17 as in production`,
			);
		},
	);
});

describe("a PostgresGate going silent", () => {
	const cleanups: (() => Promise<void>)[] = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	test("leaves an established connection open and unanswered, so that only the client's own timeout ends a statement on it", async () => {
		const gate = PostgresGate.create();
		gate.forward();
		const sql = new SQL(gate.url, { max: 1 });
		cleanups.push(async () => {
			gate.close();
			await sql.close({ timeout: 0 }).catch(() => {});
		});
		await sql`SELECT 1`;
		gate.goSilent();

		const outcome = await Promise.race([
			sql`SELECT 1`.then(
				() => "answered",
				(error: unknown) => error,
			),
			Bun.sleep(CLIENT_STATEMENT_TIMEOUT_MS).then(() => "timed_out"),
		]);

		expect(outcome).toBe("timed_out");
	});
});
