import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { OperationKind } from "@workbench/sdk";
import type { AuthenticatedToken } from "./api-tokens.ts";
import {
	type ApiRequest,
	authenticateRequest,
	type HttpApi,
} from "./http-api.ts";
import type {
	OperationRegistry,
	RegisteredOperation,
} from "./operation-registry.ts";
import {
	MAX_BODY_BYTES,
	type Problem,
	problemResponse,
	REQUEST_PROBLEMS,
	toProblemDetails,
} from "./problem-details.ts";
import { isWorkspaceId } from "./workspaces.ts";

export const MCP_PATH = "/api/mcp";

const MCP_METHOD = "POST";

const SERVER_INFO = { name: "workbench", version: "1" };

const OPERATION_NAME_SEPARATOR = ".";

const TOOL_NAME_SEPARATOR = "_";

const IS_READ_ONLY: Record<OperationKind, boolean> = {
	query: true,
	mutation: false,
};

const MCP_METHOD_NOT_ALLOWED: Problem = {
	...REQUEST_PROBLEMS.method_not_allowed,
	detail: "the MCP endpoint only accepts POST",
};

const INVALID_WORKSPACE_ARGUMENT: Problem = {
	...REQUEST_PROBLEMS.invalid_workspace_id,
	detail: "the workspace argument of the tool is not a UUID",
};

export type McpApi = Pick<HttpApi, "authenticate" | "pipeline"> & {
	readonly operations: Pick<OperationRegistry, "list">;
};

export async function answerMcpRequest(
	api: McpApi,
	incoming: ApiRequest,
): Promise<Response> {
	const { request, correlationId } = incoming;
	if (request.method !== MCP_METHOD) {
		const response = problemResponse(MCP_METHOD_NOT_ALLOWED, correlationId);
		response.headers.set("Allow", MCP_METHOD);
		return response;
	}
	const authentication = await authenticateRequest(api, incoming);
	if (!authentication.authenticated) return authentication.response;
	const server = mcpServerFor(api, authentication, correlationId);
	const transport = new WebStandardStreamableHTTPServerTransport({
		enableJsonResponse: true,
		maxRequestBodySize: MAX_BODY_BYTES,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		await server.close();
	}
}

function mcpServerFor(
	api: McpApi,
	authentication: AuthenticatedToken,
	correlationId: string,
): Server {
	const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: api.operations.list().map(toolOf),
	}));
	server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
		callTool(api, authentication, correlationId, params),
	);
	return server;
}

function toolOf(operation: RegisteredOperation): Tool {
	return {
		name: operation.name.replace(OPERATION_NAME_SEPARATOR, TOOL_NAME_SEPARATOR),
		inputSchema: {
			type: "object",
			properties: {
				workspace: { type: "string", format: "uuid" },
				input: operation.describeInput(),
			},
			required: ["workspace", "input"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: IS_READ_ONLY[operation.kind] },
	};
}

async function callTool(
	api: McpApi,
	authentication: AuthenticatedToken,
	correlationId: string,
	params: {
		readonly name: string;
		readonly arguments?: Readonly<Record<string, unknown>> | undefined;
	},
): Promise<CallToolResult> {
	const workspace = params.arguments?.workspace;
	if (typeof workspace !== "string" || !isWorkspaceId(workspace))
		return toolError(INVALID_WORKSPACE_ARGUMENT, correlationId);
	const result = await api.pipeline.invoke({
		operation: params.name.replace(
			TOOL_NAME_SEPARATOR,
			OPERATION_NAME_SEPARATOR,
		),
		actor: authentication.actor,
		apiTokenId: authentication.apiTokenId,
		idempotencyKey: null,
		workspace,
		input: params.arguments?.input,
		correlationId: correlationId,
	});
	if (!result.ok) return toolError(result.failure, correlationId);
	return { content: [{ type: "text", text: JSON.stringify(result.output) }] };
}

function toolError(problem: Problem, correlationId: string): CallToolResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify(toProblemDetails(problem, correlationId)),
			},
		],
	};
}
