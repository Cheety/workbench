import { afterEach, describe, expect, test } from "bun:test";
import {
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
} from "@workbench/sdk";
import { z } from "zod";
import { apiTokenHash } from "./api-tokens.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import type { PluginPackage } from "./kernel.ts";
import { describeHttpApi } from "./openapi.ts";
import {
	API_INSTANCE_WORKSPACE,
	type ApiInstance,
	startApiInstance,
} from "./testing/api-instance.ts";

const IN_A_MONTH = new Date("2026-12-26T08:00:00.000Z");

const WORKSPACE = API_INSTANCE_WORKSPACE;

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

const instances: ApiInstance[] = [];

afterEach(async () => {
	for (const instance of instances.splice(0)) await instance.stop();
});

async function startLedgerInstance(): Promise<ApiInstance> {
	const instance = await startApiInstance([ledger]);
	instances.push(instance);
	return instance;
}

function operationPath(operation: string): string {
	return `/api/workspaces/${WORKSPACE}/operations/${operation}`;
}

function bearer(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

describe("an operation called over HTTP", () => {
	test("answers a mutation with its output when the token is valid", async () => {
		const api = await startLedgerInstance();
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
			const api = await startLedgerInstance();
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
		const api = await startLedgerInstance();
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

describe("a mutation called over HTTP with an Idempotency-Key", () => {
	test("is run once, and a repeated call receives the same body", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();
		const headers = { ...bearer(token), "Idempotency-Key": "retry-1" };
		const first = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			headers,
		);

		const repeated = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			headers,
		);

		expect(repeated.status).toBe(200);
		expect(await repeated.text()).toBe(await first.text());
		expect(
			await api.database.sql`SELECT amount FROM plugin_ledger.entries`,
		).toEqual([{ amount: 42 }]);
	});

	test("reads a key quoted as a structured field string as the key inside the quotes", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();
		const first = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			{ ...bearer(token), "Idempotency-Key": 'retry "1"' },
		);

		const repeated = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			{ ...bearer(token), "Idempotency-Key": '"retry \\"1\\""' },
		);

		expect(await repeated.text()).toBe(await first.text());
		expect(
			await api.database.sql`SELECT amount FROM plugin_ledger.entries`,
		).toEqual([{ amount: 42 }]);
	});

	test("answers 422 idempotency_key_reused when the key comes again with another body", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();
		const headers = { ...bearer(token), "Idempotency-Key": "retry-1" };
		await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			headers,
		);

		const repeated = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 43 }),
			headers,
		);

		expect(repeated.status).toBe(422);
		expect(await repeated.json()).toEqual(
			expect.objectContaining({ code: "idempotency_key_reused" }),
		);
	});

	test.each([
		{ case: "the header twice", values: ["a", "b"] },
		{ case: "an unquoted key with a comma", values: ["a,b"] },
		{ case: "two structured field strings", values: ['"a", "b"'] },
		{ case: "a quoted key with a comma", values: ['"a, b"'] },
		{ case: "two halves of a quoted key", values: ['"a', 'b"'] },
	])(
		"answers 400 invalid_idempotency_key for $case, and runs nothing",
		async ({ values }) => {
			const api = await startLedgerInstance();
			const token = await api.issueToken();
			const headers = new Headers(bearer(token));
			for (const value of values) headers.append("Idempotency-Key", value);

			const response = await api.post(
				operationPath("ledger.addEntry"),
				JSON.stringify({ amount: 42 }),
				headers,
			);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual(
				expect.objectContaining({ code: "invalid_idempotency_key" }),
			);
			expect(
				await api.database.sql`SELECT amount FROM plugin_ledger.entries`,
			).toEqual([]);
		},
	);

	test("answers 400 invalid_idempotency_key when the key is empty, and runs nothing", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();

		const response = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			{ ...bearer(token), "Idempotency-Key": "" },
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual(
			expect.objectContaining({ code: "invalid_idempotency_key" }),
		);
		expect(
			await api.database.sql`SELECT amount FROM plugin_ledger.entries`,
		).toEqual([]);
	});
});

describe("a query called over HTTP with an Idempotency-Key", () => {
	test("ignores the header sent twice", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();
		const headers = new Headers(bearer(token));
		headers.append("Idempotency-Key", "a");
		headers.append("Idempotency-Key", "b");

		const response = await api.post(
			operationPath("ledger.listEntries"),
			JSON.stringify({}),
			headers,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ entries: [] });
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
			const api = await startLedgerInstance();

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
		const api = await startLedgerInstance();
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

describe("the audit read over HTTP", () => {
	test("names the service account and the API token of a mutation by their ids, never the token or its hash", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();
		const [issued] = z
			.array(z.object({ id: z.string(), service_account_id: z.string() }))
			.parse(
				await api.database
					.sql`SELECT id, service_account_id FROM core.api_tokens WHERE token_hash = ${apiTokenHash(token)}`,
			);
		await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			bearer(token),
		);

		const response = await api.post(
			operationPath("core.listAuditEntries"),
			JSON.stringify({ limit: 10, cursor: null }),
			bearer(token),
		);

		const body = await response.text();
		const [stored] = z
			.array(z.object({ entries: z.string() }))
			.parse(
				await api.database
					.sql`SELECT coalesce(json_agg(audit_entries), '[]')::text AS entries FROM core.audit_entries`,
			);
		expect(response.status).toBe(200);
		expect(JSON.parse(body)).toEqual({
			entries: [
				{
					id: expect.any(String),
					occurredAt: "2026-11-26T08:00:00.000Z",
					actor: { kind: "service_account", id: issued?.service_account_id },
					apiTokenId: issued?.id,
					operation: "ledger.addEntry",
					workspace: WORKSPACE,
					result: "succeeded",
				},
			],
			nextCursor: null,
		});
		expect(body).not.toContain(token);
		expect(body).not.toContain(apiTokenHash(token));
		expect(stored?.entries).not.toContain(token);
		expect(stored?.entries).not.toContain(apiTokenHash(token));
	});
});

describe("a call with another method than POST", () => {
	test.each(["GET", "PUT", "DELETE"])(
		"is answered with 405 problem details allowing POST for %s, before authentication",
		async (method) => {
			const api = await startLedgerInstance();

			const response = await api.send(method, operationPath("ledger.addEntry"));

			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("POST");
			expect(response.headers.get("Content-Type")).toBe(
				"application/problem+json",
			);
			expect(await response.json()).toEqual({
				type: "urn:workbench:problem:method_not_allowed",
				title: "Method Not Allowed",
				status: 405,
				detail: "the operation path only accepts POST",
				code: "method_not_allowed",
				correlationId: "request-1",
				issues: [],
			});
		},
	);
});

describe("a failing call over HTTP", () => {
	test("answers with the problem details of the failure", async () => {
		const api = await startLedgerInstance();
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
		const api = await startLedgerInstance();
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
		const api = await startLedgerInstance();
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
		const api = await startLedgerInstance();
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
			const api = await startLedgerInstance();
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
		const api = await startLedgerInstance();
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
		const api = await startLedgerInstance();
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
		const api = await startLedgerInstance();
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

	test("answers an internal error neutrally when the database is unreachable during authentication", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();
		api.refuseAuthenticationDatabase();

		const response = await api.post(
			operationPath("ledger.addEntry"),
			JSON.stringify({ amount: 42 }),
			bearer(token),
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
		expect(api.logEntries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "request failed",
				correlationId: "request-1",
			}),
		);
	});
});

const documentedOperationList = z.object({
	paths: z.object({
		"/api/operations": z.object({
			get: z.object({
				responses: z.object({
					"200": z.object({
						content: z.object({
							"application/json": z.object({
								schema: z.record(z.string(), z.unknown()),
							}),
						}),
					}),
				}),
			}),
		}),
	}),
});

describe("the operations listed over HTTP", () => {
	test("name every operation of the core and the active plugins with its kind, sorted by name", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();

		const response = await fetch(`${api.url}/api/operations`, {
			headers: bearer(token),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			operations: [
				{ name: "core.listAuditEntries", kind: "query" },
				{ name: "ledger.addEntry", kind: "mutation" },
				{ name: "ledger.listEntries", kind: "query" },
			],
		});
	});

	test("match the schema of the list in the OpenAPI document", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken();
		const document = documentedOperationList.parse(
			await describeHttpApi([ledger], setSystemTimer),
		);
		const documentedList = z.fromJSONSchema(
			document.paths["/api/operations"].get.responses["200"].content[
				"application/json"
			].schema,
		);

		const response = await fetch(`${api.url}/api/operations`, {
			headers: bearer(token),
		});

		expect(
			documentedList.safeParse(await response.json()).error?.issues,
		).toBeUndefined();
	});

	test("are not listed without a valid token", async () => {
		const api = await startLedgerInstance();

		const response = await api.send("GET", "/api/operations");

		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
		expect(await response.json()).toMatchObject({ code: "unauthenticated" });
	});

	test.each(["POST", "DELETE"])(
		"are answered with 405 problem details allowing GET for %s, before authentication",
		async (method) => {
			const api = await startLedgerInstance();

			const response = await api.send(method, "/api/operations");

			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("GET");
			expect(await response.json()).toEqual({
				type: "urn:workbench:problem:method_not_allowed",
				title: "Method Not Allowed",
				status: 405,
				detail: "the list of operations only accepts GET",
				code: "method_not_allowed",
				correlationId: "request-1",
				issues: [],
			});
		},
	);
});
