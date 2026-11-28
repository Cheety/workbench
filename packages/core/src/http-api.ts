import type { AuthenticatedToken, Authentication } from "./api-tokens.ts";
import { parseJsonText } from "./json-text.ts";
import type { Logger } from "./logger.ts";
import type { OperationPipeline } from "./operation-pipeline.ts";
import type { OperationRegistry } from "./operation-registry.ts";
import {
	MAX_BODY_BYTES,
	type Problem,
	problemResponse,
	REQUEST_PROBLEMS,
} from "./problem-details.ts";
import { isWorkspaceId } from "./workspaces.ts";

export const API_PATH_PREFIX = "/api/";

export const API_VERSION = "1";

export const OPERATION_PATH_TEMPLATE =
	"/api/workspaces/{workspace}/operations/{operation}";

const OPERATION_PATH_PATTERN =
	/^\/api\/workspaces\/([^/]+)\/operations\/([^/]+)$/;

export const INSTANCE_OPERATION_PATH_TEMPLATE = "/api/operations/{operation}";

const INSTANCE_OPERATION_PATH_PATTERN = /^\/api\/operations\/([^/]+)$/;

const OPERATION_METHOD = "POST";

export const OPERATION_LIST_PATH = "/api/operations";

const OPERATION_LIST_METHOD = "GET";

const OPERATION_LIST_METHOD_NOT_ALLOWED: Problem = {
	...REQUEST_PROBLEMS.method_not_allowed,
	detail: "the list of operations only accepts GET",
};

const BEARER = /^Bearer ([^\s]+)$/i;

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

const STRUCTURED_FIELD_STRING = /^"((?:[^"\\]|\\["\\])*)"$/;

const STRUCTURED_FIELD_ESCAPE = /\\(["\\])/g;

export type HttpApi = {
	readonly authenticate: (token: string) => Promise<Authentication>;
	readonly pipeline: OperationPipeline;
	readonly operations: Pick<OperationRegistry, "list">;
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

export type RequestAuthentication =
	| AuthenticatedToken
	| { readonly authenticated: false; readonly response: Response };

export async function authenticateRequest(
	api: Pick<HttpApi, "authenticate">,
	{ request, correlationId, logger }: Omit<ApiRequest, "path">,
): Promise<RequestAuthentication> {
	const token = bearerToken(request);
	const authentication: ApiAuthentication =
		token === undefined
			? { authenticated: false, reason: "missing_token" }
			: await api.authenticate(token);
	if (authentication.authenticated) return authentication;
	logger.warn("request not authenticated", {
		reason: authentication.reason,
	});
	const response = problemResponse(
		REQUEST_PROBLEMS.unauthenticated,
		correlationId,
	);
	response.headers.set("WWW-Authenticate", "Bearer");
	return { authenticated: false, response };
}

export async function answerApiRequest(
	api: HttpApi,
	{ request, path, correlationId, logger }: ApiRequest,
): Promise<Response> {
	if (path === OPERATION_LIST_PATH)
		return listOperations(api, { request, correlationId, logger });
	const route = routeOf(path);
	if (route !== null && request.method !== OPERATION_METHOD) {
		const response = problemResponse(
			REQUEST_PROBLEMS.method_not_allowed,
			correlationId,
		);
		response.headers.set("Allow", OPERATION_METHOD);
		return response;
	}
	const authentication = await authenticateRequest(api, {
		request,
		correlationId,
		logger,
	});
	if (!authentication.authenticated) return authentication.response;
	if (route === null)
		return problemResponse(REQUEST_PROBLEMS.route_not_found, correlationId);
	const workspace =
		route.workspace === null ? null : decodedSegment(route.workspace);
	const operation = decodedSegment(route.operation);
	if (workspace === undefined || operation === undefined)
		return problemResponse(REQUEST_PROBLEMS.malformed_path, correlationId);
	if (workspace !== null && !isWorkspaceId(workspace))
		return problemResponse(
			REQUEST_PROBLEMS.invalid_workspace_id,
			correlationId,
		);
	const body = await limitedText(request);
	if (body === undefined)
		return problemResponse(REQUEST_PROBLEMS.body_too_large, correlationId);
	const input = parseJsonText(body);
	if (!input.parsed)
		return problemResponse(REQUEST_PROBLEMS.invalid_input, correlationId);
	const result = await api.pipeline.invoke({
		operation,
		actor: authentication.actor,
		apiTokenId: authentication.apiTokenId,
		idempotencyKey: idempotencyKeyOf(request),
		workspace,
		input: input.value,
		correlationId,
	});
	return result.ok
		? Response.json(result.output)
		: problemResponse(result.failure, correlationId);
}

type OperationRoute = {
	readonly workspace: string | null;
	readonly operation: string;
};

function routeOf(path: string): OperationRoute | null {
	const onWorkspace = OPERATION_PATH_PATTERN.exec(path);
	if (onWorkspace !== null) {
		const [, workspace = "", operation = ""] = onWorkspace;
		return { workspace, operation };
	}
	const onInstance = INSTANCE_OPERATION_PATH_PATTERN.exec(path);
	if (onInstance === null) return null;
	const [, operation = ""] = onInstance;
	return { workspace: null, operation };
}

async function listOperations(
	api: HttpApi,
	incoming: Omit<ApiRequest, "path">,
): Promise<Response> {
	if (incoming.request.method !== OPERATION_LIST_METHOD) {
		const response = problemResponse(
			OPERATION_LIST_METHOD_NOT_ALLOWED,
			incoming.correlationId,
		);
		response.headers.set("Allow", OPERATION_LIST_METHOD);
		return response;
	}
	const authentication = await authenticateRequest(api, incoming);
	if (!authentication.authenticated) return authentication.response;
	return Response.json({
		operations: api.operations
			.list()
			.map(({ name, kind }) => ({ name, kind }))
			.toSorted((left, right) => left.name.localeCompare(right.name)),
	});
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

function idempotencyKeyOf(request: Request): string | null {
	const header = request.headers.get(IDEMPOTENCY_KEY_HEADER);
	if (header === null) return null;
	const quoted = STRUCTURED_FIELD_STRING.exec(header);
	if (quoted === null) return header;
	const [, inside = ""] = quoted;
	return inside.replace(STRUCTURED_FIELD_ESCAPE, "$1");
}

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
