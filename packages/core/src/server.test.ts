import { afterEach, describe, expect, test } from "bun:test";
import { Secret } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createPostgresCheck } from "./postgres.ts";
import { type RunningServer, startServer } from "./server.ts";
import { PostgresGate } from "./testing/postgres.ts";

type LogEntry = Record<string, unknown>;

let running: RunningServer | undefined;

afterEach(async () => {
	await running?.stop();
	running = undefined;
});

function startTestServer(gate: PostgresGate) {
	const lines: string[] = [];
	let nextId = 1;
	const server = startServer({
		port: 0,
		logger: createLogger({
			level: "debug",
			now: () => new Date("2026-11-26T08:00:00.000Z"),
			write: (line) => lines.push(line),
		}),
		checkDatabase: createPostgresCheck({
			url: new Secret(gate.url),
			timeoutMs: 5000,
		}),
		newCorrelationId: () => `generated-${nextId++}`,
	});
	running = server;
	return {
		get: (path: string, headers: Record<string, string> = {}) =>
			fetch(`http://127.0.0.1:${server.port}${path}`, { headers }),
		logEntries: (): LogEntry[] => lines.map((line) => JSON.parse(line)),
	};
}

describe("liveness", () => {
	test("answers alive while Postgres is unreachable", async () => {
		const { get } = startTestServer(PostgresGate.create());

		const response = await get("/health/live");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "alive" });
	});
});

describe("readiness", () => {
	test("reports not ready while Postgres is unreachable", async () => {
		const { get } = startTestServer(PostgresGate.create());

		const response = await get("/health/ready");

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "not_ready" });
	});

	test("reports ready once Postgres becomes reachable", async () => {
		const gate = PostgresGate.create();
		const { get } = startTestServer(gate);
		expect((await get("/health/ready")).status).toBe(503);
		gate.forward();

		const response = await get("/health/ready");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ready" });
	});

	test("reports not ready again when Postgres goes away", async () => {
		const gate = PostgresGate.create();
		gate.forward();
		const { get } = startTestServer(gate);
		expect((await get("/health/ready")).status).toBe(200);
		gate.refuse();

		const response = await get("/health/ready");

		expect(response.status).toBe(503);
	});

	test("logs why it is not ready without leaking the database credentials", async () => {
		const gate = PostgresGate.create();
		const { get, logEntries } = startTestServer(gate);

		await get("/health/ready");

		expect(logEntries()).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message: "not ready: database unreachable",
				reason: "ERR_POSTGRES_CONNECTION_REFUSED",
			}),
		);
		expect(JSON.stringify(logEntries())).not.toContain(
			new URL(gate.url).password,
		);
	});
});

describe("correlation ID", () => {
	test("generates one per request, returns it and logs it", async () => {
		const { get, logEntries } = startTestServer(PostgresGate.create());

		const response = await get("/health/live");

		expect(response.headers.get("X-Correlation-ID")).toBe("generated-1");
		expect(logEntries()).toEqual([
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "debug",
				message: "request completed",
				correlationId: "generated-1",
				method: "GET",
				path: "/health/live",
				status: 200,
			},
		]);
	});

	test("adopts a valid incoming one", async () => {
		const { get, logEntries } = startTestServer(PostgresGate.create());

		const response = await get("/health/live", {
			"X-Correlation-ID": "client-42.a_b",
		});

		expect(response.headers.get("X-Correlation-ID")).toBe("client-42.a_b");
		expect(logEntries()[0]).toMatchObject({ correlationId: "client-42.a_b" });
	});

	test.each([
		["with characters outside the allowed set", 'inject"ed {id}'],
		["that is too long", "a".repeat(129)],
	])("replaces an incoming one %s", async (_case, incoming) => {
		const { get, logEntries } = startTestServer(PostgresGate.create());

		const response = await get("/health/live", {
			"X-Correlation-ID": incoming,
		});

		expect(response.headers.get("X-Correlation-ID")).toBe("generated-1");
		expect(logEntries()[0]).toMatchObject({ correlationId: "generated-1" });
	});
});

describe("unknown routes", () => {
	test("answer with a problem document and a logged correlation ID", async () => {
		const { get, logEntries } = startTestServer(PostgresGate.create());

		const response = await get("/nowhere?token=abc");

		expect(response.status).toBe(404);
		expect(response.headers.get("Content-Type")).toBe(
			"application/problem+json",
		);
		expect(await response.json()).toEqual({
			type: "about:blank",
			title: "Not Found",
			status: 404,
		});
		expect(logEntries()).toEqual([
			expect.objectContaining({
				level: "info",
				correlationId: "generated-1",
				path: "/nowhere",
				status: 404,
			}),
		]);
	});
});
