import { afterEach, describe, expect, test } from "bun:test";
import { authenticateToken } from "./api-tokens.ts";
import { Secret } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createOperationPipeline } from "./operation-pipeline.ts";
import { registerOperations } from "./operation-registry.ts";
import { createPostgresCheck } from "./postgres.ts";
import {
	type RunningServer,
	type StartupStatus,
	startServer,
} from "./server.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	PostgresGate,
} from "./testing/postgres.ts";

const PARALLEL_PROBES = 300;

const NOW = new Date("2026-11-26T08:00:00.000Z");

type LogEntry = Record<string, unknown>;

let running: RunningServer | undefined;
let openGate: PostgresGate | undefined;
let database: FreshDatabase | undefined;

afterEach(async () => {
	await running?.stop();
	running = undefined;
	openGate?.close();
	openGate = undefined;
	await database?.drop();
	database = undefined;
});

async function startTestServer(startupStatus: StartupStatus = "started") {
	const gate = PostgresGate.create();
	openGate = gate;
	database = await createFreshDatabase();
	const { sql } = database;
	const lines: string[] = [];
	let nextId = 1;
	const logger = createLogger({
		level: "debug",
		now: () => NOW,
		write: (line) => lines.push(line),
	});
	const server = startServer({
		port: 0,
		logger,
		checkDatabase: createPostgresCheck({
			url: new Secret(gate.url),
			timeoutMs: 5000,
		}),
		newCorrelationId: () => `generated-${nextId++}`,
		startupStatus: () => startupStatus,
		api: {
			authenticate: (token) => authenticateToken(sql, token, NOW),
			pipeline: createOperationPipeline({
				sql,
				registry: registerOperations([]),
				now: () => NOW,
				newId: () => "00000000-0000-4000-8000-000000000001",
				newAuditEntryId: () => "00000000-0000-4000-a000-000000000001",
				random: () => 0.5,
				logger,
			}),
		},
	});
	running = server;
	return {
		gate,
		get: (path: string, headers: Record<string, string> = {}) =>
			fetch(`http://127.0.0.1:${server.port}${path}`, { headers }),
		post: (path: string) =>
			fetch(`http://127.0.0.1:${server.port}${path}`, {
				method: "POST",
				body: "{}",
			}),
		logEntries: (): LogEntry[] => lines.map((line) => JSON.parse(line)),
	};
}

describe("liveness", () => {
	test("answers alive while Postgres is unreachable", async () => {
		const { get } = await startTestServer();

		const response = await get("/health/live");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "alive" });
	});
});

describe("readiness", () => {
	test("reports not ready while Postgres is unreachable", async () => {
		const { get } = await startTestServer();

		const response = await get("/health/ready");

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "not_ready" });
	});

	test("reports ready once Postgres becomes reachable", async () => {
		const { get, gate } = await startTestServer();
		const whileUnreachable = await get("/health/ready");
		gate.forward();

		const response = await get("/health/ready");

		expect(whileUnreachable.status).toBe(503);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ready" });
	});

	test("reports not ready again when Postgres goes away", async () => {
		const { get, gate } = await startTestServer();
		gate.forward();
		const whileReachable = await get("/health/ready");
		gate.refuse();

		const response = await get("/health/ready");

		expect(whileReachable.status).toBe(200);
		expect(response.status).toBe(503);
	});

	test("stays ready when more probes arrive at once than Postgres has connections", async () => {
		const { get, gate } = await startTestServer();
		gate.forward();

		const responses = await Promise.all(
			Array.from({ length: PARALLEL_PROBES }, () => get("/health/ready")),
		);

		expect(
			responses.filter((response) => response.status !== 200),
		).toHaveLength(0);
	});

	test("reports not ready while the instance is still starting, even with Postgres reachable", async () => {
		const { get, gate, logEntries } = await startTestServer("starting");
		gate.forward();

		const response = await get("/health/ready");

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "not_ready" });
		expect(logEntries()).toContainEqual(
			expect.objectContaining({
				level: "debug",
				message: "not ready: instance starting",
			}),
		);
	});

	test("reports not ready and says so when the instance failed to start", async () => {
		const { get, gate, logEntries } = await startTestServer("failed");
		gate.forward();

		const response = await get("/health/ready");

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "not_ready" });
		expect(logEntries()).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message: "not ready: instance failed to start",
			}),
		);
	});

	test("logs why it is not ready without leaking the database credentials", async () => {
		const { get, gate, logEntries } = await startTestServer();

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
		const { get, logEntries } = await startTestServer();

		const response = await get("/health/live");

		expect(response.headers.get("X-Correlation-ID")).toBe("generated-1");
		expect(logEntries()).toEqual([
			expect.objectContaining({
				message: "request completed",
				correlationId: "generated-1",
			}),
		]);
	});

	test("adopts a valid incoming one", async () => {
		const { get, logEntries } = await startTestServer();

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
		const { get, logEntries } = await startTestServer();

		const response = await get("/health/live", {
			"X-Correlation-ID": incoming,
		});

		expect(response.headers.get("X-Correlation-ID")).toBe("generated-1");
		expect(logEntries()[0]).toMatchObject({ correlationId: "generated-1" });
	});
});

describe("unknown routes", () => {
	test("answer with a problem document and a logged correlation ID", async () => {
		const { get, logEntries } = await startTestServer();

		const response = await get("/nowhere?token=abc");

		expect(response.status).toBe(404);
		expect(response.headers.get("Content-Type")).toBe(
			"application/problem+json",
		);
		expect(await response.json()).toEqual({
			type: "urn:workbench:problem:route_not_found",
			title: "Not Found",
			status: 404,
			detail: "no route matches the method and path of the request",
			code: "route_not_found",
			correlationId: "generated-1",
			issues: [],
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

describe("the HTTP API", () => {
	test("answers 503 problem details while the instance is still starting", async () => {
		const { post } = await startTestServer("starting");

		const response = await post(
			"/api/workspaces/00000000-0000-4000-8000-00000000aaaa/operations/board.renameLabel",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			type: "urn:workbench:problem:instance_not_ready",
			title: "Service Unavailable",
			status: 503,
			detail: "the instance is still starting",
			code: "instance_not_ready",
			correlationId: "generated-1",
			issues: [],
		});
	});

	test("answers 503 problem details when the instance failed to start", async () => {
		const { post } = await startTestServer("failed");

		const response = await post(
			"/api/workspaces/00000000-0000-4000-8000-00000000aaaa/operations/board.renameLabel",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			type: "urn:workbench:problem:instance_not_ready",
			title: "Service Unavailable",
			status: 503,
			detail: "the instance failed to start",
			code: "instance_not_ready",
			correlationId: "generated-1",
			issues: [],
		});
	});
});
