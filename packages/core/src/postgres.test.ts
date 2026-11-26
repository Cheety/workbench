import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Secret } from "./config.ts";
import { createPostgresCheck } from "./postgres.ts";
import { PostgresGate, TEST_DATABASE_URL } from "./testing/postgres.ts";

describe("test database", () => {
	test("is a real Postgres 17", async () => {
		const sql = new SQL(TEST_DATABASE_URL, { max: 1 });

		const [row] =
			await sql`SELECT current_setting('server_version_num')::int / 10000 AS major`;
		await sql.close();

		expect(row).toEqual({ major: 17 });
	});
});

describe("createPostgresCheck", () => {
	test("reports Postgres reachable when it answers", async () => {
		const check = createPostgresCheck({
			url: new Secret(TEST_DATABASE_URL),
			timeoutMs: 5000,
		});

		expect(await check()).toEqual({ reachable: true });
	});

	test("reports a timeout when Postgres accepts the connection but never answers", async () => {
		const gate = PostgresGate.create();
		gate.goSilent();
		const check = createPostgresCheck({
			url: new Secret(gate.url),
			timeoutMs: 50,
		});

		const status = await check();
		gate.refuse();

		expect(status).toEqual({ reachable: false, reason: "timeout" });
	});

	test("reports wrong credentials as unreachable instead of failing", async () => {
		const url = new URL(TEST_DATABASE_URL);
		url.password = "not-the-password";
		const check = createPostgresCheck({
			url: new Secret(url.href),
			timeoutMs: 5000,
		});

		expect(await check()).toEqual({ reachable: false, reason: "28P01" });
	});
});
