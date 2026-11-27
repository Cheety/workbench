import type { Authentication } from "./api-tokens.ts";
import type { Logger } from "./logger.ts";
import type { OperationPipeline } from "./operation-pipeline.ts";
import {
	type Problem,
	problemResponse,
	ROUTE_NOT_FOUND,
} from "./problem-details.ts";
import { isWorkspaceId } from "./workspaces.ts";

export const API_PATH_PREFIX = "/api/";

export const OPERATION_PATH_TEMPLATE =
	"/api/workspaces/{workspace}/operations/{operation}";

const OPERATION_PATH = /^\/api\/workspaces\/([^/]+)\/operations\/([^/]+)$/;

export const MAX_BODY_BYTES = 1024 * 1024;

const BEARER = /^Bearer ([^\s]+)$/;

export type HttpApi = {
	readonly authenticate: (token: string) => Promise<Authentication>;
	readonly pipeline: OperationPipeline;
};

export type ApiRequest = {
	readonly request: Request;
	readonly path: string;
	readonly correlationId: string;
	readonly logger: Logger;
};

type ApiAuthentication =
	| Authentication
	| { readonly authenticated: false; readonly reason: "missing_token" };

const UNAUTHENTICATED: Problem = {
	code: "unauthenticated",
	kind: "unauthenticated",
	detail: "the request needs a valid API token as a bearer token",
	issues: [],
};

const BODY_TOO_LARGE: Problem = {
	code: "body_too_large",
	kind: "too_large",
	detail: `the request body exceeds ${MAX_BODY_BYTES} bytes`,
	issues: [],
};

const MALFORMED_PATH: Problem = {
	code: "malformed_path",
	kind: "invalid_input",
	detail: "the path of the request is not valid percent-encoding",
	issues: [],
};

const INVALID_WORKSPACE_ID: Problem = {
	code: "invalid_workspace_id",
	kind: "invalid_input",
	detail: "the workspace in the path is not a UUID",
	issues: [],
};

const BODY_NOT_JSON: Problem = {
	code: "invalid_input",
	kind: "invalid_input",
	detail: "the request body is not JSON",
	issues: [],
};

export async function answerApiRequest(
	api: HttpApi,
	{ request, path, correlationId, logger }: ApiRequest,
): Promise<Response> {
	const token = bearerToken(request);
	const authentication: ApiAuthentication =
		token === undefined
			? { authenticated: false, reason: "missing_token" }
			: await api.authenticate(token);
	if (!authentication.authenticated) {
		logger.warn("request not authenticated", {
			reason: authentication.reason,
		});
		const response = problemResponse(UNAUTHENTICATED, correlationId);
		response.headers.set("WWW-Authenticate", "Bearer");
		return response;
	}
	const route = OPERATION_PATH.exec(path);
	if (request.method !== "POST" || route === null)
		return problemResponse(ROUTE_NOT_FOUND, correlationId);
	const [, encodedWorkspace = "", encodedOperation = ""] = route;
	const workspace = decodedSegment(encodedWorkspace);
	const operation = decodedSegment(encodedOperation);
	if (workspace === undefined || operation === undefined)
		return problemResponse(MALFORMED_PATH, correlationId);
	if (!isWorkspaceId(workspace))
		return problemResponse(INVALID_WORKSPACE_ID, correlationId);
	const body = await limitedText(request);
	if (body === undefined) return problemResponse(BODY_TOO_LARGE, correlationId);
	const input = parsedJson(body);
	if (!input.parsed) return problemResponse(BODY_NOT_JSON, correlationId);
	const result = await api.pipeline.invoke({
		operation,
		actor: authentication.actor,
		workspace,
		input: input.value,
		correlationId,
	});
	return result.ok
		? Response.json(result.output)
		: problemResponse(result.failure, correlationId);
}

function decodedSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch (error) {
		if (error instanceof URIError) return undefined;
		throw error;
	}
}

function bearerToken(request: Request): string | undefined {
	const header = request.headers.get("Authorization");
	if (header === null) return undefined;
	return BEARER.exec(header)?.[1];
}

type JsonBody =
	| { readonly parsed: true; readonly value: unknown }
	| { readonly parsed: false };

async function limitedText(request: Request): Promise<string | undefined> {
	if (request.body === null) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of request.body) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function parsedJson(text: string): JsonBody {
	try {
		const value: unknown = JSON.parse(text);
		return { parsed: true, value };
	} catch (error) {
		if (error instanceof SyntaxError) return { parsed: false };
		throw error;
	}
}
