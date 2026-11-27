import type { Authentication } from "./api-tokens.ts";
import type { Logger } from "./logger.ts";
import type { OperationPipeline } from "./operation-pipeline.ts";
import {
	MAX_BODY_BYTES,
	problemResponse,
	REQUEST_PROBLEMS,
} from "./problem-details.ts";
import { isWorkspaceId } from "./workspaces.ts";

export const API_PATH_PREFIX = "/api/";

export const OPERATION_PATH_TEMPLATE =
	"/api/workspaces/{workspace}/operations/{operation}";

const OPERATION_PATH = /^\/api\/workspaces\/([^/]+)\/operations\/([^/]+)$/;

const OPERATION_METHOD = "POST";

const BEARER = /^Bearer ([^\s]+)$/i;

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

export async function answerApiRequest(
	api: HttpApi,
	{ request, path, correlationId, logger }: ApiRequest,
): Promise<Response> {
	const route = OPERATION_PATH.exec(path);
	if (route !== null && request.method !== OPERATION_METHOD) {
		const response = problemResponse(
			REQUEST_PROBLEMS.method_not_allowed,
			correlationId,
		);
		response.headers.set("Allow", OPERATION_METHOD);
		return response;
	}
	const token = bearerToken(request);
	const authentication: ApiAuthentication =
		token === undefined
			? { authenticated: false, reason: "missing_token" }
			: await api.authenticate(token);
	if (!authentication.authenticated) {
		logger.warn("request not authenticated", {
			reason: authentication.reason,
		});
		const response = problemResponse(
			REQUEST_PROBLEMS.unauthenticated,
			correlationId,
		);
		response.headers.set("WWW-Authenticate", "Bearer");
		return response;
	}
	if (route === null)
		return problemResponse(REQUEST_PROBLEMS.route_not_found, correlationId);
	const [, encodedWorkspace = "", encodedOperation = ""] = route;
	const workspace = decodedSegment(encodedWorkspace);
	const operation = decodedSegment(encodedOperation);
	if (workspace === undefined || operation === undefined)
		return problemResponse(REQUEST_PROBLEMS.malformed_path, correlationId);
	if (!isWorkspaceId(workspace))
		return problemResponse(
			REQUEST_PROBLEMS.invalid_workspace_id,
			correlationId,
		);
	const body = await limitedText(request);
	if (body === undefined)
		return problemResponse(REQUEST_PROBLEMS.body_too_large, correlationId);
	const input = parsedJson(body);
	if (!input.parsed)
		return problemResponse(REQUEST_PROBLEMS.invalid_input, correlationId);
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
