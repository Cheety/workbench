import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
	OperationError,
} from "@workbench/sdk";
import { z } from "zod";
import type { PluginPackage } from "./kernel.ts";
import {
	API_INSTANCE_WORKSPACE,
	type ApiInstance,
} from "./testing/api-instance.ts";
import { mcpTestbed } from "./testing/mcp-testbed.ts";
import { pluginPackageAt } from "./testing/operation-harness.ts";

const REFERENCE_DIRECTORY = join(
	new URL("../../", import.meta.url).pathname,
	"plugin-reference",
);

const UNKNOWN_WORKSPACE = "00000000-0000-4000-8000-00000000bbbb";

const mcp = mcpTestbed();

afterEach(() => mcp.tearDown());

const closeBook = defineOperation({
	name: "closeBook",
	kind: "mutation",
	target: "workspace",
	right: "ledger.book.close",
	input: z.object({ year: z.number().int() }),
	output: z.object({ year: z.number().int() }),
	execute: async ({ year }) => {
		throw new OperationError(
			"conflict",
			"book_already_closed",
			`the book of ${year} is already closed`,
		);
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
		operations: [closeBook],
	}),
	loadMigrations: async () => [],
};

async function startReferenceInstance(): Promise<ApiInstance> {
	return mcp.startInstance([await pluginPackageAt(REFERENCE_DIRECTORY)]);
}

const answer = z.record(z.string(), z.unknown());

type Answer = z.infer<typeof answer>;

type Call = {
	readonly operation: string;
	readonly workspace: string;
	readonly input: unknown;
};

async function overHttp(
	api: ApiInstance,
	token: string,
	{ operation, workspace, input }: Call,
): Promise<Answer> {
	const response = await api.post(
		`/api/workspaces/${workspace}/operations/${operation}`,
		JSON.stringify(input),
		{ Authorization: `Bearer ${token}` },
	);
	return answer.parse(await response.json());
}

async function overMcp(
	api: ApiInstance,
	token: string,
	{ operation, workspace, input }: Call,
): Promise<Answer> {
	const client = await mcp.connectedClient(api.url, token);
	const result = await client.callTool({
		name: operation.replace(".", "_"),
		arguments: { workspace, input },
	});
	const { content } = z
		.object({
			content: z.tuple([
				z.object({ type: z.literal("text"), text: z.string() }),
			]),
		})
		.parse(result);
	return answer.parse(JSON.parse(content[0].text));
}

describe("the reference operations listed as MCP tools", () => {
	test("name createNote and listNotes with the input schema of the HTTP API contract under input", async () => {
		const api = await startReferenceInstance();
		const client = await mcp.connectedClient(api.url, await api.issueToken());

		const { tools } = await client.listTools();

		expect(tools.filter((tool) => tool.name.startsWith("reference_"))).toEqual([
			{
				name: "reference_createNote",
				inputSchema: {
					type: "object",
					properties: {
						workspace: { type: "string", format: "uuid" },
						input: {
							type: "object",
							properties: {
								title: { type: "string", minLength: 1, maxLength: 200 },
							},
							required: ["title"],
						},
					},
					required: ["workspace", "input"],
					additionalProperties: false,
				},
				annotations: { readOnlyHint: false },
			},
			{
				name: "reference_listNotes",
				inputSchema: {
					type: "object",
					properties: {
						workspace: { type: "string", format: "uuid" },
						input: {
							type: "object",
							properties: {
								limit: { type: "integer", minimum: 1, maximum: 100 },
							},
							required: ["limit"],
						},
					},
					required: ["workspace", "input"],
					additionalProperties: false,
				},
				annotations: { readOnlyHint: true },
			},
		]);
	});
});

describe("an operation of the reference plugin over MCP and over HTTP", () => {
	test("answers the reference mutation with the same output", async () => {
		const overHttpApi = await startReferenceInstance();
		const overMcpApi = await startReferenceInstance();
		const call = {
			operation: "reference.createNote",
			workspace: API_INSTANCE_WORKSPACE,
			input: { title: "Plan" },
		};

		const answeredOverHttp = await overHttp(
			overHttpApi,
			await overHttpApi.issueToken(),
			call,
		);
		const answeredOverMcp = await overMcp(
			overMcpApi,
			await overMcpApi.issueToken(),
			call,
		);

		expect(answeredOverHttp).toEqual({
			id: expect.any(String),
			title: "Plan",
			createdAt: "2026-11-26T08:00:00.000Z",
		});
		expect(answeredOverMcp).toEqual(answeredOverHttp);
	});

	test("reaches the same operation, so a note created over MCP is listed over HTTP", async () => {
		const api = await startReferenceInstance();
		const token = await api.issueToken();
		const created = await overMcp(api, token, {
			operation: "reference.createNote",
			workspace: API_INSTANCE_WORKSPACE,
			input: { title: "Plan" },
		});

		const listed = await overHttp(api, token, {
			operation: "reference.listNotes",
			workspace: API_INSTANCE_WORKSPACE,
			input: { limit: 10 },
		});

		expect(listed).toEqual({ notes: [created] });
	});

	test.each([
		{
			case: "an empty title",
			code: "invalid_input",
			workspace: API_INSTANCE_WORKSPACE,
			input: { title: " " },
		},
		{
			case: "a workspace that does not exist",
			code: "workspace_not_found",
			workspace: UNKNOWN_WORKSPACE,
			input: { title: "Plan" },
		},
	])(
		"fails for $case with the same problem details and stable code $code",
		async ({ code, workspace, input }) => {
			const api = await startReferenceInstance();
			const token = await api.issueToken();
			const call = { operation: "reference.createNote", workspace, input };

			const failedOverHttp = await overHttp(api, token, call);
			const failedOverMcp = await overMcp(api, token, call);

			expect(failedOverHttp).toMatchObject({ code });
			expect(failedOverMcp).toEqual({
				...failedOverHttp,
				correlationId: expect.any(String),
			});
		},
	);
});

describe("a domain error of a plugin over MCP and over HTTP", () => {
	test("comes with the same problem details, status and stable code of the plugin", async () => {
		const api = await mcp.startInstance([ledger]);
		const token = await api.issueToken();
		const call = {
			operation: "ledger.closeBook",
			workspace: API_INSTANCE_WORKSPACE,
			input: { year: 2025 },
		};

		const failedOverHttp = await overHttp(api, token, call);
		const failedOverMcp = await overMcp(api, token, call);

		expect(failedOverHttp).toEqual({
			type: "urn:workbench:problem:ledger.book_already_closed",
			title: "Conflict",
			status: 409,
			detail: "the book of 2025 is already closed",
			code: "ledger.book_already_closed",
			correlationId: expect.any(String),
			issues: [],
		});
		expect(failedOverMcp).toEqual({
			...failedOverHttp,
			correlationId: expect.any(String),
		});
	});
});
