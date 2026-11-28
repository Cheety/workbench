import { afterEach, describe, expect, test } from "bun:test";
import {
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
	OperationError,
} from "@workbench/sdk";
import { z } from "zod";
import type { PluginPackage } from "./kernel.ts";
import { OPENAPI_DOCUMENT_PATH } from "./openapi.ts";
import {
	API_INSTANCE_WORKSPACE,
	type ApiInstance,
} from "./testing/api-instance.ts";
import { MCP_PATH, mcpTestbed } from "./testing/mcp-testbed.ts";

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
		if (amount === 0)
			throw new OperationError(
				"rejected",
				"empty_entry",
				"an entry needs an amount other than zero",
			);
		const id = ctx.newId();
		await ctx.sql`INSERT INTO entries (id, workspace_id, amount) VALUES (${id}, ${ctx.workspace}, ${amount})`;
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
		rights: [
			{ name: "ledger.entry.add", defaultRoles: ["owner"] },
			{ name: "ledger.entry.read", defaultRoles: ["owner"] },
		],
		operations: [addEntry, listEntries],
	}),
	loadMigrations: async () => [
		{
			name: "0001_create_entries.sql",
			sql: "CREATE TABLE entries (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, amount integer NOT NULL);",
		},
	],
};

const mcp = mcpTestbed();

afterEach(() => mcp.tearDown());

function startLedgerInstance(): Promise<ApiInstance> {
	return mcp.startInstance([ledger]);
}

const toolResult = z.object({
	isError: z.boolean().optional(),
	content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
});

function textOf(result: unknown): {
	readonly isError: boolean;
	readonly json: unknown;
} {
	const { isError, content } = toolResult.parse(result);
	return { isError: isError ?? false, json: JSON.parse(content[0].text) };
}

function toolsCall(name: string, args: unknown): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
}

const TOOLS_LIST = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "tools/list",
});

const MCP_HEADERS = {
	Accept: "application/json, text/event-stream",
	"Content-Type": "application/json",
	"MCP-Protocol-Version": "2025-11-25",
};

describe("the MCP server of the instance", () => {
	test("names itself workbench in the version of the API contract", async () => {
		const api = await startLedgerInstance();
		const { info } = z
			.object({ info: z.object({ version: z.string() }) })
			.parse(await Bun.file(OPENAPI_DOCUMENT_PATH).json());

		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		expect(client.getServerVersion()).toEqual({
			name: "workbench",
			version: info.version,
		});
	});
});

describe("the operations listed as MCP tools", () => {
	test("name each operation of the core and the active plugins with its input schema inside a workspace", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		const { tools } = await client.listTools();

		expect(tools.map((tool) => tool.name).toSorted()).toEqual([
			"core_listAuditEntries",
			"ledger_addEntry",
			"ledger_listEntries",
		]);
		expect(tools.find((tool) => tool.name === "ledger_addEntry")).toEqual({
			name: "ledger_addEntry",
			inputSchema: {
				type: "object",
				properties: {
					workspace: { type: "string", format: "uuid" },
					input: {
						type: "object",
						properties: {
							amount: {
								type: "integer",
								minimum: -9007199254740991,
								maximum: 9007199254740991,
							},
						},
						required: ["amount"],
					},
					idempotencyKey: { type: "string", pattern: "^[ -+\\--~]{1,255}$" },
				},
				required: ["workspace", "input"],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: false },
		});
	});

	test("mark a query as read-only", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		const { tools } = await client.listTools();

		expect(
			tools.find((tool) => tool.name === "ledger_listEntries")?.annotations,
		).toEqual({ readOnlyHint: true });
	});
});

describe("the idempotency key of an MCP tool", () => {
	test("is offered by a mutation and not by a query", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		const { tools } = await client.listTools();

		expect(
			tools.map((tool) => ({
				name: tool.name,
				takesKey: "idempotencyKey" in (tool.inputSchema.properties ?? {}),
			})),
		).toEqual(
			expect.arrayContaining([
				{ name: "ledger_addEntry", takesKey: true },
				{ name: "ledger_listEntries", takesKey: false },
			]),
		);
	});

	test("answers a repeated mutation with the output of the first call without running it again", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);
		const call = {
			name: "ledger_addEntry",
			arguments: {
				workspace: WORKSPACE,
				input: { amount: 42 },
				idempotencyKey: "retry-1",
			},
		};
		const first = await client.callTool(call);

		const repeated = await client.callTool(call);

		const listed = await client.callTool({
			name: "ledger_listEntries",
			arguments: { workspace: WORKSPACE, input: {} },
		});
		expect(textOf(repeated)).toEqual(textOf(first));
		expect(textOf(listed).json).toEqual({ entries: [textOf(first).json] });
	});

	test("rejects the same key with another input with idempotency_key_reused", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);
		await client.callTool({
			name: "ledger_addEntry",
			arguments: {
				workspace: WORKSPACE,
				input: { amount: 42 },
				idempotencyKey: "retry-1",
			},
		});

		const result = await client.callTool({
			name: "ledger_addEntry",
			arguments: {
				workspace: WORKSPACE,
				input: { amount: 7 },
				idempotencyKey: "retry-1",
			},
		});

		expect(textOf(result)).toEqual({
			isError: true,
			json: expect.objectContaining({ code: "idempotency_key_reused" }),
		});
	});

	test.each([
		["is not a string", 42],
		["is empty", ""],
	])(
		"rejects a key that %s with invalid_idempotency_key",
		async (_case, key) => {
			const api = await startLedgerInstance();
			const client = await mcp.connectedClient(
				api.url,
				await api.issueToken("owner"),
			);

			const result = await client.callTool({
				name: "ledger_addEntry",
				arguments: {
					workspace: WORKSPACE,
					input: { amount: 42 },
					idempotencyKey: key,
				},
			});

			expect(textOf(result)).toEqual({
				isError: true,
				json: expect.objectContaining({ code: "invalid_idempotency_key" }),
			});
		},
	);
});

describe("the idempotency key of an MCP tool calling a query", () => {
	test.each([
		["a string", "retry-1"],
		["not a string", 42],
	])("is ignored when it is %s", async (_case, key) => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		const result = await client.callTool({
			name: "ledger_listEntries",
			arguments: { workspace: WORKSPACE, input: {}, idempotencyKey: key },
		});

		expect(textOf(result)).toEqual({ isError: false, json: { entries: [] } });
	});
});

describe("an operation called as an MCP tool", () => {
	test("answers a mutation with its output as JSON text", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		const result = await client.callTool({
			name: "ledger_addEntry",
			arguments: { workspace: WORKSPACE, input: { amount: 42 } },
		});

		expect(textOf(result)).toEqual({
			isError: false,
			json: { id: expect.any(String), amount: 42 },
		});
	});

	test("answers a query with what a mutation wrote before", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);
		const added = await client.callTool({
			name: "ledger_addEntry",
			arguments: { workspace: WORKSPACE, input: { amount: 42 } },
		});
		const { id } = entry.parse(textOf(added).json);

		const result = await client.callTool({
			name: "ledger_listEntries",
			arguments: { workspace: WORKSPACE, input: {} },
		});

		expect(textOf(result).json).toEqual({ entries: [{ id, amount: 42 }] });
	});

	test("writes an audit entry naming the service account and the API token of the call", async () => {
		const api = await startLedgerInstance();
		const { token, serviceAccountId, apiTokenId } =
			await api.issueIdentifiedToken("owner");
		const client = await mcp.connectedClient(api.url, token);
		await client.callTool({
			name: "ledger_addEntry",
			arguments: { workspace: WORKSPACE, input: { amount: 42 } },
		});

		const audited = await client.callTool({
			name: "core_listAuditEntries",
			arguments: { workspace: WORKSPACE, input: { limit: 10, cursor: null } },
		});

		expect(textOf(audited)).toEqual({
			isError: false,
			json: {
				entries: [
					{
						id: expect.any(String),
						occurredAt: "2026-11-26T08:00:00.000Z",
						actor: { kind: "service_account", id: serviceAccountId },
						apiTokenId,
						operation: "ledger.addEntry",
						workspace: WORKSPACE,
						result: "succeeded",
					},
				],
				nextCursor: null,
			},
		});
	});
});

describe("a failing MCP tool call", () => {
	test("answers a domain error as a tool error with the problem details and stable code of the operation", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		const result = await client.callTool({
			name: "ledger_addEntry",
			arguments: { workspace: WORKSPACE, input: { amount: 0 } },
		});

		expect(textOf(result)).toEqual({
			isError: true,
			json: {
				type: "urn:workbench:problem:ledger.empty_entry",
				title: "Unprocessable Content",
				status: 422,
				detail: "an entry needs an amount other than zero",
				code: "ledger.empty_entry",
				correlationId: expect.any(String),
				issues: [],
			},
		});
	});

	test("answers an input that does not match the schema as a tool error with its issues", async () => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		const result = await client.callTool({
			name: "ledger_addEntry",
			arguments: { workspace: WORKSPACE, input: { amount: "a lot" } },
		});

		expect(textOf(result)).toMatchObject({
			isError: true,
			json: { code: "invalid_input", issues: [{ path: ["amount"] }] },
		});
	});

	test.each([
		{ case: "is not a UUID", args: { workspace: "accounts", input: {} } },
		{ case: "is missing", args: { input: {} } },
	])(
		"answers invalid_workspace_id when the workspace $case",
		async ({ args }) => {
			const api = await startLedgerInstance();
			const client = await mcp.connectedClient(
				api.url,
				await api.issueToken("owner"),
			);

			const result = await client.callTool({
				name: "ledger_listEntries",
				arguments: args,
			});

			expect(textOf(result)).toMatchObject({
				isError: true,
				json: { code: "invalid_workspace_id" },
			});
		},
	);

	test.each([
		{ case: "a tool no plugin registered", name: "ledger_closeBook" },
		{
			case: "the name of an operation instead of its tool",
			name: "ledger.listEntries",
		},
	])("answers unknown_operation for $case", async ({ name }) => {
		const api = await startLedgerInstance();
		const client = await mcp.connectedClient(
			api.url,
			await api.issueToken("owner"),
		);

		const result = await client.callTool({
			name,
			arguments: { workspace: WORKSPACE, input: {} },
		});

		expect(textOf(result)).toMatchObject({
			isError: true,
			json: { code: "unknown_operation" },
		});
	});
});

describe("an MCP request with a body over 1 MiB", () => {
	test("is answered with 413 and calls no tool", async () => {
		const api = await startLedgerInstance();
		const token = await api.issueToken("owner");

		const response = await api.post(
			MCP_PATH,
			toolsCall("ledger_addEntry", {
				workspace: WORKSPACE,
				input: { amount: 42, padding: "x".repeat(1024 * 1024) },
			}),
			{ ...MCP_HEADERS, Authorization: `Bearer ${token}` },
		);

		expect(response.status).toBe(413);
		expect(
			await api.database.sql`SELECT amount FROM plugin_ledger.entries`,
		).toEqual([]);
	});
});

const WITHOUT_VALID_TOKEN = [
	{ case: "no token", reason: "missing_token", headers: async () => ({}) },
	{
		case: "an unknown token",
		reason: "unknown_token",
		headers: async () => ({ Authorization: "Bearer wbt_never-issued" }),
	},
	{
		case: "an expired token",
		reason: "expired_token",
		headers: async (api: ApiInstance) => {
			const token = await api.issueToken("owner");
			api.setClock(IN_A_MONTH);
			return { Authorization: `Bearer ${token}` };
		},
	},
];

describe("an MCP request without a valid token", () => {
	test.each(WITHOUT_VALID_TOKEN)(
		"is rejected with 401 problem details and calls no tool when it carries $case",
		async ({ reason, headers }) => {
			const api = await startLedgerInstance();

			const response = await api.post(
				MCP_PATH,
				toolsCall("ledger_addEntry", {
					workspace: WORKSPACE,
					input: { amount: 42 },
				}),
				{ ...MCP_HEADERS, ...(await headers(api)) },
			);

			expect(response.status).toBe(401);
			expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
			expect(await response.json()).toMatchObject({
				code: "unauthenticated",
			});
			expect(api.logEntries).toContainEqual(
				expect.objectContaining({
					level: "warn",
					message: "request not authenticated",
					reason,
				}),
			);
			expect(
				await api.database.sql`SELECT amount FROM plugin_ledger.entries`,
			).toEqual([]);
		},
	);

	test.each(WITHOUT_VALID_TOKEN)(
		"is rejected with 401 problem details instead of the tools when it lists them with $case",
		async ({ reason, headers }) => {
			const api = await startLedgerInstance();

			const response = await api.post(MCP_PATH, TOOLS_LIST, {
				...MCP_HEADERS,
				...(await headers(api)),
			});

			expect(response.status).toBe(401);
			expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
			expect(await response.json()).toEqual({
				type: "urn:workbench:problem:unauthenticated",
				title: "Unauthorized",
				status: 401,
				detail: "the request needs a valid API token as a bearer token",
				code: "unauthenticated",
				correlationId: expect.any(String),
				issues: [],
			});
			expect(api.logEntries).toContainEqual(
				expect.objectContaining({
					level: "warn",
					message: "request not authenticated",
					reason,
				}),
			);
		},
	);
});

describe("an MCP request with another method than POST", () => {
	test.each(["GET", "DELETE"])(
		"is answered with 405 problem details allowing POST for %s",
		async (method) => {
			const api = await startLedgerInstance();

			const response = await api.send(method, MCP_PATH);

			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("POST");
			expect(await response.json()).toMatchObject({
				code: "method_not_allowed",
			});
		},
	);
});
