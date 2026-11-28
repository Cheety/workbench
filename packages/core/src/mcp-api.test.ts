import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
	startApiInstance,
} from "./testing/api-instance.ts";

const IN_A_MONTH = new Date("2026-12-26T08:00:00.000Z");

const WORKSPACE = API_INSTANCE_WORKSPACE;

const MCP_PATH = "/api/mcp";

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

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	for (const instance of instances.splice(0)) await instance.stop();
});

async function startLedgerInstance(): Promise<ApiInstance> {
	const instance = await startApiInstance([ledger]);
	instances.push(instance);
	return instance;
}

async function connectedClient(
	api: ApiInstance,
	token: string,
): Promise<Client> {
	const client = new Client({ name: "ledger-agent", version: "1.0.0" });
	clients.push(client);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${api.url}${MCP_PATH}`), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);
	return client;
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

		const client = await connectedClient(api, await api.issueToken());

		expect(client.getServerVersion()).toEqual({
			name: "workbench",
			version: info.version,
		});
	});
});

describe("the operations listed as MCP tools", () => {
	test("name each operation of the core and the active plugins with its input schema inside a workspace", async () => {
		const api = await startLedgerInstance();
		const client = await connectedClient(api, await api.issueToken());

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
				},
				required: ["workspace", "input"],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: false },
		});
	});

	test("mark a query as read-only", async () => {
		const api = await startLedgerInstance();
		const client = await connectedClient(api, await api.issueToken());

		const { tools } = await client.listTools();

		expect(
			tools.find((tool) => tool.name === "ledger_listEntries")?.annotations,
		).toEqual({ readOnlyHint: true });
	});
});

describe("an operation called as an MCP tool", () => {
	test("answers a mutation with its output as JSON text", async () => {
		const api = await startLedgerInstance();
		const client = await connectedClient(api, await api.issueToken());

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
		const client = await connectedClient(api, await api.issueToken());
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
		const client = await connectedClient(api, await api.issueToken());
		await client.callTool({
			name: "ledger_addEntry",
			arguments: { workspace: WORKSPACE, input: { amount: 42 } },
		});

		const audited = await api.database
			.sql`SELECT a.operation FROM core.audit_entries a JOIN core.api_tokens t ON t.id = a.api_token_id AND t.service_account_id::text = a.actor_id`;

		expect(audited).toEqual([{ operation: "ledger.addEntry" }]);
	});
});

describe("a failing MCP tool call", () => {
	test("answers a domain error as a tool error with the problem details and stable code of the operation", async () => {
		const api = await startLedgerInstance();
		const client = await connectedClient(api, await api.issueToken());

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
		const client = await connectedClient(api, await api.issueToken());

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
			const client = await connectedClient(api, await api.issueToken());

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
		const client = await connectedClient(api, await api.issueToken());

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
		const token = await api.issueToken();

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

describe("an MCP request without a valid token", () => {
	test.each([
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
				const token = await api.issueToken();
				api.setClock(IN_A_MONTH);
				return { Authorization: `Bearer ${token}` };
			},
		},
	])(
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

	test("lists no tools", async () => {
		const api = await startLedgerInstance();

		const connecting = connectedClient(api, "wbt_never-issued");

		await expect(connecting).rejects.toThrow();
		expect(api.logEntries).toContainEqual(
			expect.objectContaining({ message: "request not authenticated" }),
		);
	});
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
