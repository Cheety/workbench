import { afterEach, describe, expect, test } from "bun:test";
import { Secret } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createPostgresCheck } from "./postgres.ts";
import { PostgresGate, TEST_DATABASE_URL } from "./testing/postgres.ts";

const PARALLEL_CHECKS = 20;

const logger = createLogger({
	level: "error",
	now: () => new Date("2026-11-26T08:00:00.000Z"),
	write: () => {},
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

		expect(await check(logger)).toEqual({ reachable: true });
	});

	test("reports a timeout when Postgres accepts the connection but never answers", async () => {
		const gate = openGate();
		gate.goSilent();
		const check = createPostgresCheck({
			url: new Secret(gate.url),
			timeoutMs: 50,
		});

		const status = await check(logger);

		expect(status).toEqual({ reachable: false, reason: "timeout" });
	});

	test("shares one connection among checks that run at the same time", async () => {
		const gate = openGate();
		gate.forward();
		const check = createPostgresCheck({
			url: new Secret(gate.url),
			timeoutMs: 5000,
		});

		const statuses = await Promise.all(
			Array.from({ length: PARALLEL_CHECKS }, () => check(logger)),
		);

		expect(statuses).toEqual(
			Array.from({ length: PARALLEL_CHECKS }, () => ({ reachable: true })),
		);
		expect(gate.acceptedConnections).toBe(1);
	});

	test("checks again after a hung check has reached its deadline", async () => {
		const gate = openGate();
		gate.goSilent();
		const check = createPostgresCheck({
			url: new Secret(gate.url),
			timeoutMs: 500,
		});
		const hung = await check(logger);
		gate.forward();

		const status = await check(logger);

		expect(hung).toEqual({ reachable: false, reason: "timeout" });
		expect(status).toEqual({ reachable: true });
	});

	test("reports wrong credentials as unreachable instead of failing", async () => {
		const url = new URL(TEST_DATABASE_URL);
		url.password = "not-the-password";
		const check = createPostgresCheck({
			url: new Secret(url.href),
			timeoutMs: 5000,
		});

		expect(await check(logger)).toEqual({ reachable: false, reason: "28P01" });
	});
});
