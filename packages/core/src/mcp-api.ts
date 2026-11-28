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
	API_VERSION,
	type ApiRequest,
	authenticateRequest,
	type HttpApi,
} from "./http-api.ts";
import {
	IDEMPOTENCY_KEY_PATTERN,
	TAKES_IDEMPOTENCY_KEY,
} from "./idempotency-keys.ts";
import { INVALID_IDEMPOTENCY_KEY } from "./operation-pipeline.ts";
import {
	OPERATION_NAME_SEPARATOR,
	type OperationRegistry,
	type RegisteredOperation,
} from "./operation-registry.ts";
import {
	MAX_BODY_BYTES,
	type Problem,
	problemResponse,
	REQUEST_PROBLEMS,
	toProblemDetails,
} from "./problem-details.ts";
import { quote } from "./quote.ts";
import { isWorkspaceId } from "./workspaces.ts";

export const MCP_PATH = "/api/mcp";

const MCP_METHOD = "POST";

const SERVER_INFO = { name: "workbench", version: API_VERSION };

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

const IDEMPOTENCY_KEY_ARGUMENT = {
	type: "string",
	pattern: IDEMPOTENCY_KEY_PATTERN,
};

export type McpApi = Pick<HttpApi, "authenticate" | "pipeline" | "operations">;

type McpRequest = {
	readonly api: McpApi;
	readonly authentication: AuthenticatedToken;
	readonly correlationId: string;
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
	const server = mcpServerFor({ api, authentication, correlationId });
	const transport = new WebStandardStreamableHTTPServerTransport({
		enableJsonResponse: true,
		maxRequestBodySize: MAX_BODY_BYTES,
	});
	try {
		await server.connect(transport);
		return await transport.handleRequest(request);
	} finally {
		await server.close();
	}
}

function mcpServerFor(mcpRequest: McpRequest): Server {
	const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: mcpRequest.api.operations.list().map(toolOf),
	}));
	server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
		callTool(mcpRequest, params),
	);
	return server;
}

function toolNameOf(operationName: string): string {
	return operationName.replace(OPERATION_NAME_SEPARATOR, TOOL_NAME_SEPARATOR);
}

function findOperationOfTool(
	operations: Pick<OperationRegistry, "list">,
	toolName: string,
): RegisteredOperation | undefined {
	return operations
		.list()
		.find((operation) => toolNameOf(operation.name) === toolName);
}

function toolOf(operation: RegisteredOperation): Tool {
	return {
		name: toolNameOf(operation.name),
		inputSchema: {
			type: "object",
			properties: {
				workspace: { type: "string", format: "uuid" },
				input: operation.describeInput(),
				...(TAKES_IDEMPOTENCY_KEY[operation.kind]
					? { idempotencyKey: IDEMPOTENCY_KEY_ARGUMENT }
					: {}),
			},
			required: ["workspace", "input"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: IS_READ_ONLY[operation.kind] },
	};
}

async function callTool(
	{ api, authentication, correlationId }: McpRequest,
	params: {
		readonly name: string;
		readonly arguments?: Readonly<Record<string, unknown>> | undefined;
	},
): Promise<CallToolResult> {
	const workspace = params.arguments?.workspace;
	if (typeof workspace !== "string" || !isWorkspaceId(workspace))
		return toolError(INVALID_WORKSPACE_ARGUMENT, correlationId);
	const operation = findOperationOfTool(api.operations, params.name);
	if (operation === undefined)
		return toolError(unknownTool(params.name), correlationId);
	const key = params.arguments?.idempotencyKey ?? null;
	const idempotencyKey = typeof key === "string" ? key : null;
	if (key !== idempotencyKey && TAKES_IDEMPOTENCY_KEY[operation.kind])
		return toolError(INVALID_IDEMPOTENCY_KEY, correlationId);
	const result = await api.pipeline.invoke({
		operation: operation.name,
		actor: authentication.actor,
		apiTokenId: authentication.apiTokenId,
		idempotencyKey,
		workspace,
		input: params.arguments?.input,
		correlationId,
	});
	if (!result.ok) return toolError(result.failure, correlationId);
	return { content: [{ type: "text", text: JSON.stringify(result.output) }] };
}

function unknownTool(toolName: string): Problem {
	return {
		code: "unknown_operation",
		kind: "not_found",
		detail: `no tool is named ${quote(toolName)}`,
		issues: [],
	};
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
