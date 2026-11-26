import { afterEach, describe, expect, test } from "bun:test";
import { Secret } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createPostgresCheck } from "./postgres.ts";
import { type RunningServer, startServer } from "./server.ts";
import { PostgresGate } from "./testing/postgres.ts";

const PARALLEL_PROBES = 300;

type LogEntry = Record<string, unknown>;

let running: RunningServer | undefined;
let openGate: PostgresGate | undefined;

afterEach(async () => {
	await running?.stop();
	running = undefined;
	openGate?.close();
	openGate = undefined;
});

function startTestServer() {
	const gate = PostgresGate.create();
	openGate = gate;
	const lines: string[] = [];
	let nextId = 1;
	const logger = createLogger({
		level: "debug",
		now: () => new Date("2026-11-26T08:00:00.000Z"),
		write: (line) => lines.push(line),
	});
	const server = startServer({
		port: 0,
		logger,
		checkDatabase: createPostgresCheck({
			url: new Secret(gate.url),
			timeoutMs: 5000,
			logger,
		}),
		newCorrelationId: () => `generated-${nextId++}`,
	});
	running = server;
	return {
		gate,
		get: (path: string, headers: Record<string, string> = {}) =>
			fetch(`http://127.0.0.1:${server.port}${path}`, { headers }),
		logEntries: (): LogEntry[] => lines.map((line) => JSON.parse(line)),
	};
}

describe("liveness", () => {
	test("answers alive while Postgres is unreachable", async () => {
		const { get } = startTestServer();

		const response = await get("/health/live");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "alive" });
	});
});

describe("readiness", () => {
	test("reports not ready while Postgres is unreachable", async () => {
		const { get } = startTestServer();

		const response = await get("/health/ready");

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "not_ready" });
	});

	test("reports ready once Postgres becomes reachable", async () => {
		const { get, gate } = startTestServer();
		const whileUnreachable = await get("/health/ready");
		gate.forward();

		const response = await get("/health/ready");

		expect(whileUnreachable.status).toBe(503);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ready" });
	});

	test("reports not ready again when Postgres goes away", async () => {
		const { get, gate } = startTestServer();
		gate.forward();
		const whileReachable = await get("/health/ready");
		gate.refuse();

		const response = await get("/health/ready");

		expect(whileReachable.status).toBe(200);
		expect(response.status).toBe(503);
	});

	test("stays ready when more probes arrive at once than Postgres has connections", async () => {
		const { get, gate } = startTestServer();
		gate.forward();

		const responses = await Promise.all(
			Array.from({ length: PARALLEL_PROBES }, () => get("/health/ready")),
		);

		expect(
			responses.filter((response) => response.status !== 200),
		).toHaveLength(0);
	});

	test("logs why it is not ready without leaking the database credentials", async () => {
		const { get, gate, logEntries } = startTestServer();

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
		const { get, logEntries } = startTestServer();

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
		const { get, logEntries } = startTestServer();

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
		const { get, logEntries } = startTestServer();

		const response = await get("/health/live", {
			"X-Correlation-ID": incoming,
		});

		expect(response.headers.get("X-Correlation-ID")).toBe("generated-1");
		expect(logEntries()[0]).toMatchObject({ correlationId: "generated-1" });
	});
});

describe("unknown routes", () => {
	test("answer with a problem document and a logged correlation ID", async () => {
		const { get, logEntries } = startTestServer();

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
