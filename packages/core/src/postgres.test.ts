import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Secret } from "./config.ts";
import { createPostgresCheck } from "./postgres.ts";
import { PostgresGate, TEST_DATABASE_URL } from "./testing/postgres.ts";

describe("test database", () => {
	let sql: SQL | undefined;

	afterEach(async () => {
		await sql?.close();
		sql = undefined;
	});

	test("is a real Postgres 17", async () => {
		sql = new SQL(TEST_DATABASE_URL, { max: 1 });

		const [row] =
			await sql`SELECT current_setting('server_version_num')::int / 10000 AS major`;

		expect(row).toEqual({ major: 17 });
	});
});

describe("createPostgresCheck", () => {
	const gates: PostgresGate[] = [];

	afterEach(() => {
		for (const gate of gates.splice(0)) gate.close();
	});

	function openGate(): PostgresGate {
		const gate = PostgresGate.create();
		gates.push(gate);
		return gate;
	}

	test("reports Postgres reachable when it answers", async () => {
		const check = createPostgresCheck({
			url: new Secret(TEST_DATABASE_URL),
			timeoutMs: 5000,
		});

		expect(await check()).toEqual({ reachable: true });
	});

	test("reports a timeout when Postgres accepts the connection but never answers", async () => {
		const gate = openGate();
		gate.goSilent();
		const check = createPostgresCheck({
			url: new Secret(gate.url),
			timeoutMs: 50,
		});

		const status = await check();

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
