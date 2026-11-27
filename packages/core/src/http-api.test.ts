import { afterEach, describe, expect, test } from "bun:test";
import {
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
} from "@workbench/sdk";
import { z } from "zod";
import { authenticateToken } from "./api-tokens.ts";
import { Secret } from "./config.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { type PluginPackage, startPlugins } from "./kernel.ts";
import { createOperationPipeline } from "./operation-pipeline.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "./schema-migrations.ts";
import { type RunningServer, startServer } from "./server.ts";
import { createServiceAccount } from "./service-accounts.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { type LogEntry, recordingLogger } from "./testing/recording-logger.ts";
import { createWorkspace } from "./workspaces.ts";

const NOW = new Date("2026-11-26T08:00:00.000Z");

const IN_A_MONTH = new Date("2026-12-26T08:00:00.000Z");

const WORKSPACE = "00000000-0000-4000-8000-00000000aaaa";

const NOT_STOPPED = new AbortController().signal;

const entry = z.object({ id: z.string(), amount: z.number().int() });

const addEntry = defineOperation({
	name: "addEntry",
	kind: "mutation",
	target: "workspace",
	right: "ledger.entry.add",
	input: z.object({ amount: z.number().int() }),
	output: entry,
	execute: async ({ amount }, ctx) => {
		const id = ctx.newId();
		await ctx.sql`INSERT INTO entries (id, workspace_id, amount) VALUES (${id}, ${ctx.workspace}, ${amount})`;
		if (amount < 0) throw new Error("negative amount at /srv/ledger/entries");
		return { id, amount };
	},
});

const listEntries = defineOperation({
	name: "listEntries",
	kind: "query",
	target: "workspace",
	right: "ledger.entry.read",
	input: z.object({}),
	output: z.object({ entries: z.array(entry) }),
	execute: async (_input, ctx) => {
		const rows =
			await ctx.sql`SELECT id, amount FROM entries WHERE workspace_id = ${ctx.workspace} ORDER BY id`;
		return { entries: z.array(entry).parse(rows) };
	},
});

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () => ({
		...definePlugin({
			manifest: { name: "ledger", capabilities: [DATABASE_CAPABILITY] },
		}),
		operations: [addEntry, listEntries],
	}),
	loadMigrations: async () => [
		{
			name: "0001_create_entries.sql",
			sql: "CREATE TABLE entries (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, amount integer NOT NULL);",
		},
	],
};

type ApiInstance = {
	readonly database: FreshDatabase;
	readonly logEntries: readonly LogEntry[];
	issueToken(): Promise<string>;
	setClock(now: Date): void;
	post(
		path: string,
		body: string,
		headers: Record<string, string>,
	): Promise<Response>;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startApiInstance(): Promise<ApiInstance> {
	const { logger, entries } = recordingLogger();
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	const runner: MigrationRunner = {
		databaseUrl: new Secret(database.url),
		connectionTimeoutMs: 10_000,
		statementTimeoutMs: 60_000,
		lockRetryDelayMs: () => 0,
		setTimer: setSystemTimer,
		logger,
	};
	await migrateCoreSchema(runner, CORE_MIGRATIONS_DIRECTORY, NOT_STOPPED);
	const plugins = await startPlugins({
		discover: async () => ({ packages: [ledger], unreadable: [] }),
		enabledPlugins: ["ledger"],
		capabilityProviders: {},
		migrateSchemas: (schemas) => migrateSchemas(runner, schemas, NOT_STOPPED),
		hookTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
	cleanups.push(async () => {
		await plugins.deactivate();
	});
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Accounts",
		createdAt: NOW,
	});
	let issuedIds = 0;
	const newId = () => {
		issuedIds += 1;
		return `00000000-0000-4000-8000-${String(issuedIds).padStart(12, "0")}`;
	};
	let clock = NOW;
	let issuedTokens = 0;
	let issuedCorrelationIds = 0;
	const server: RunningServer = startServer({
		port: 0,
		logger,
		checkDatabase: async () => ({ reachable: true }),
		newCorrelationId: () => {
			issuedCorrelationIds += 1;
			return `request-${issuedCorrelationIds}`;
		},
		startupStatus: () => "started",
		api: {
			authenticate: (token) => authenticateToken(database.sql, token, clock),
			pipeline: createOperationPipeline({
				sql: database.sql,
				registry: plugins.operations,
				now: () => clock,
				newId,
				random: () => 0.5,
				logger,
			}),
		},
	});
	cleanups.push(() => server.stop());
	return {
		database,
		logEntries: entries,
		issueToken: async () => {
			issuedTokens += 1;
			const issued = await createServiceAccount(
				database.sql,
				{ name: `agent ${issuedTokens}`, validDays: 30 },
				{
					now: () => clock,
					newId,
					newToken: () => `wbt_test-token-${issuedTokens}`,
				},
			);
			return issued.token;
		},
		setClock: (now) => {
			clock = now;
		},
		post: (path, body, headers) =>
			fetch(`http://127.0.0.1:${server.port}${path}`, {
				method: "POST",
				body,
				headers,
			}),
	};
}

function operationPath(operation: string): string {
	return `/api/workspaces/${WORKSPACE}/operations/${operation}`;
}

function bearer(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

describe("an operation called over HTTP", () => {
	test("answers a mutation with its output when the token is valid", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();

		const response = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			bearer(token),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: expect.any(String),
			amount: 42,
		});
	});

	test.each(["bearer", "BEARER"])(
		"accepts the token in the scheme spelled %s",
		async (scheme) => {
			const api = await startApiInstance();
			const token = await api.issueToken();

			const response = await api.post(
				operationPath("ledger.addEntry"),
				JSON.stringify({ amount: 42 }),
				{ Authorization: `${scheme} ${token}` },
			);

			expect(response.status).toBe(200);
		},
	);

	test("answers a query with what a mutation wrote before", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();
		const added = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			bearer(token),
		);
		const { id } = z.object({ id: z.string() }).parse(await added.json());

		const response = await api.post(
			operationPath("ledger.listEntries"),
			JSON.stringify({}),
			bearer(token),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			entries: [{ id, amount: 42 }],
		});
	});
});

describe("a call without a valid token", () => {
	test.each([
		{ case: "no token", reason: "missing_token", headers: async () => ({}) },
		{
			case: "a token in another scheme",
			reason: "missing_token",
			headers: async (api: ApiInstance) => ({
				Authorization: `Basic ${await api.issueToken()}`,
			}),
		},
		{
			case: "an unknown token",
			reason: "unknown_token",
			headers: async () => bearer("wbt_never-issued"),
		},
		{
			case: "an expired token",
			reason: "expired_token",
			headers: async (api: ApiInstance) => {
				const token = await api.issueToken();
				api.setClock(IN_A_MONTH);
				return bearer(token);
			},
		},
	])(
		"is rejected with 401 problem details when it carries $case",
		async ({ reason, headers }) => {
			const api = await startApiInstance();

			const response = await api.post(
				operationPath("ledger.addEntry"),
				JSON.stringify({ amount: 42 }),
				await headers(api),
			);

			expect(response.status).toBe(401);
			expect(response.headers.get("Content-Type")).toBe(
				"application/problem+json",
			);
			expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
			expect(await response.json()).toEqual({
				type: "urn:workbench:problem:unauthenticated",
				title: "Unauthorized",
				status: 401,
				detail: "the request needs a valid API token as a bearer token",
				code: "unauthenticated",
				correlationId: "request-1",
				issues: [],
			});
			expect(api.logEntries).toContainEqual(
				expect.objectContaining({
					level: "warn",
					message: "request not authenticated",
					correlationId: "request-1",
					reason,
				}),
			);
		},
	);

	test("leaves the operation unexecuted", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();

		await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			bearer("wbt_never-issued"),
		);
		const listed = await api.post(
			operationPath("ledger.listEntries"),
			JSON.stringify({}),
			bearer(token),
		);

		expect(await listed.json()).toEqual({ entries: [] });
	});
});

describe("a failing call over HTTP", () => {
	test("answers with the problem details of the failure", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();

		const response = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: "a lot" }),
			bearer(token),
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("Content-Type")).toBe(
			"application/problem+json",
		);
		expect(await response.json()).toMatchObject({
			type: "urn:workbench:problem:invalid_input",
			status: 400,
			code: "invalid_input",
			correlationId: "request-1",
			issues: [{ path: ["amount"] }],
		});
	});

	test("answers 400 problem details when the body is not JSON", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();

		const response = await api.post(
			operationPath("ledger.addEntry"),
			"{amount: 42",
			bearer(token),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "invalid_input",
			detail: "the request body is not JSON",
		});
	});

	test("answers 413 problem details when the body exceeds 1 MiB", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();

		const response = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42, padding: "x".repeat(1024 * 1024) }),
			bearer(token),
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			code: "body_too_large",
			detail: "the request body exceeds 1048576 bytes",
		});
	});

	test("accepts a body of exactly 1 MiB", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();
		const body = JSON.stringify({ amount: 42, padding: "" });

		const response = await api.post(
			operationPath("ledger.addEntry"),
			body.padEnd(1024 * 1024, " "),
			bearer(token),
		);

		expect(response.status).toBe(200);
	});

	test.each([
		{
			case: "operation",
			path: `/api/workspaces/${WORKSPACE}/operations/ledger.%E0`,
		},
		{
			case: "workspace",
			path: "/api/workspaces/%E0/operations/ledger.addEntry",
		},
	])(
		"answers 400 problem details when the $case in the path is not valid percent-encoding",
		async ({ path }) => {
			const api = await startApiInstance();
			const token = await api.issueToken();

			const response = await api.post(
				path,
				JSON.stringify({ amount: 42 }),
				bearer(token),
			);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				code: "malformed_path",
				detail: "the path of the request is not valid percent-encoding",
			});
		},
	);

	test("answers 400 problem details when the workspace in the path is not a UUID", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();

		const response = await api.post(
			"/api/workspaces/accounts/operations/ledger.addEntry",
			JSON.stringify({ amount: 42 }),
			bearer(token),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "invalid_workspace_id",
			detail: "the workspace in the path is not a UUID",
		});
	});

	test("answers 404 problem details for an operation no plugin registered", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();

		const response = await api.post(
			operationPath("ledger.closeBook"),
			JSON.stringify({}),
			bearer(token),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ code: "unknown_operation" });
	});

	test("answers an internal error neutrally and keeps the details in the log", async () => {
		const api = await startApiInstance();
		const token = await api.issueToken();

		const response = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: -1 }),
			bearer(token),
		);

		expect(response.status).toBe(500);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({
			type: "urn:workbench:problem:internal_error",
			title: "Internal Server Error",
			status: 500,
			detail: "the operation failed for an internal reason",
			code: "internal_error",
			correlationId: "request-1",
			issues: [],
		});
		expect(body).not.toContain("/srv/ledger");
		expect(api.logEntries).toContainEqual(
			expect.objectContaining({
				message: "operation failed",
				correlationId: "request-1",
				error: expect.objectContaining({
					message: "negative amount at /srv/ledger/entries",
				}),
			}),
		);
	});

	test("answers an internal error neutrally when authentication itself fails", async () => {
		const api = await startApiInstance();
		await api.database.sql`DROP TABLE core.api_tokens`;

		const response = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			bearer("wbt_any"),
		);

		expect(response.status).toBe(500);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({
			type: "urn:workbench:problem:internal_error",
			title: "Internal Server Error",
			status: 500,
			detail: "the request failed for an internal reason",
			code: "internal_error",
			correlationId: "request-1",
			issues: [],
		});
		expect(body).not.toContain("api_tokens");
		expect(api.logEntries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "request failed",
				correlationId: "request-1",
				error: expect.objectContaining({
					message: expect.stringContaining("api_tokens"),
				}),
			}),
		);
	});
});
