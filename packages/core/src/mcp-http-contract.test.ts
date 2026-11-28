import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
	API_INSTANCE_WORKSPACE,
	type ApiInstance,
	startApiInstance,
} from "./testing/api-instance.ts";
import { pluginPackageAt } from "./testing/operation-harness.ts";

const REFERENCE_DIRECTORY = join(
	new URL("../../", import.meta.url).pathname,
	"plugin-reference",
);

const UNKNOWN_WORKSPACE = "00000000-0000-4000-8000-00000000bbbb";

const instances: ApiInstance[] = [];

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	for (const instance of instances.splice(0)) await instance.stop();
});

async function startReferenceInstance(): Promise<ApiInstance> {
	const instance = await startApiInstance([
		await pluginPackageAt(REFERENCE_DIRECTORY),
	]);
	instances.push(instance);
	return instance;
}

type Call = {
	readonly operation: string;
	readonly workspace: string;
	readonly input: unknown;
};

async function overHttp(
	api: ApiInstance,
	token: string,
	{ operation, workspace, input }: Call,
): Promise<string> {
	const response = await api.post(
		`/api/workspaces/${workspace}/operations/${operation}`,
		JSON.stringify(input),
		{ Authorization: `Bearer ${token}` },
	);
	return response.text();
}

async function overMcp(
	api: ApiInstance,
	token: string,
	{ operation, workspace, input }: Call,
): Promise<string> {
	const client = new Client({ name: "reference-agent", version: "1.0.0" });
	clients.push(client);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${api.url}/api/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);
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
	return content[0].text;
}

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

		expect(JSON.parse(answeredOverHttp)).toEqual({
			id: expect.any(String),
			title: "Plan",
			createdAt: "2026-11-26T08:00:00.000Z",
		});
		expect(answeredOverMcp).toBe(answeredOverHttp);
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

		expect(JSON.parse(listed)).toEqual({ notes: [JSON.parse(created)] });
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

			const failedOverHttp = JSON.parse(await overHttp(api, token, call));
			const failedOverMcp = JSON.parse(await overMcp(api, token, call));

			expect(failedOverHttp).toMatchObject({ code });
			expect(failedOverMcp).toEqual({
				...failedOverHttp,
				correlationId: expect.any(String),
			});
		},
	);
});
