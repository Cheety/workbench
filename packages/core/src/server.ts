import { describeThrown } from "./failure-reason.ts";
import { API_PATH_PREFIX, answerApiRequest, type HttpApi } from "./http-api.ts";
import type { Logger } from "./logger.ts";
import { answerMcpRequest, MCP_PATH } from "./mcp-api.ts";
import type { DatabaseCheck } from "./postgres.ts";
import {
	problemResponse,
	REQUEST_PROBLEMS,
	type UnreadyStartupStatus,
} from "./problem-details.ts";

export const CORRELATION_ID_HEADER = "X-Correlation-ID";

export const VALID_CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const HEALTH_PATH_PREFIX = "/health/";
const LIVENESS_PATH = "/health/live";
const READINESS_PATH = "/health/ready";

const HEALTH_STATUS = {
	alive: "alive",
	ready: "ready",
	notReady: "not_ready",
} as const;

export type StartupStatus = "started" | UnreadyStartupStatus;

type IncomingRequest = {
	readonly request: Request;
	readonly path: string;
	readonly correlationId: string;
	readonly logger: Logger;
};

export type ServerOptions = {
	readonly port: number;
	readonly logger: Logger;
	readonly checkDatabase: DatabaseCheck;
	readonly newCorrelationId: () => string;
	readonly startupStatus: () => StartupStatus;
	readonly api: HttpApi;
};

export type RunningServer = {
	readonly port: number;
	stop(): Promise<void>;
};

export function startServer(options: ServerOptions): RunningServer {
	const server = Bun.serve({
		port: options.port,
		fetch: (request) => handleRequest(request, options),
	});
	const port = server.port;
	if (port === undefined)
		throw new Error("server is not listening on a TCP port");
	return { port, stop: () => server.stop(true) };
}

async function handleRequest(
	request: Request,
	options: ServerOptions,
): Promise<Response> {
	const correlationId =
		acceptCorrelationId(request) ?? options.newCorrelationId();
	const logger = options.logger.with({ correlationId });
	const path = new URL(request.url).pathname;
	const response = await route(
		{ request, path, correlationId, logger },
		options,
	).catch((error: unknown) => {
		logger.error("request failed", { error: describeThrown(error) });
		return problemResponse(REQUEST_PROBLEMS.internal_error, correlationId);
	});
	response.headers.set(CORRELATION_ID_HEADER, correlationId);
	const entry = { method: request.method, path, status: response.status };
	const level = path.startsWith(HEALTH_PATH_PREFIX) ? "debug" : "info";
	logger[level]("request completed", entry);
	return response;
}

function acceptCorrelationId(request: Request): string | undefined {
	const incoming = request.headers.get(CORRELATION_ID_HEADER);
	return incoming !== null && VALID_CORRELATION_ID.test(incoming)
		? incoming
		: undefined;
}

async function route(
	incoming: IncomingRequest,
	options: ServerOptions,
): Promise<Response> {
	const { request, path, correlationId, logger } = incoming;
	if (request.method === "GET" && path === LIVENESS_PATH)
		return Response.json({ status: HEALTH_STATUS.alive });
	if (request.method === "GET" && path === READINESS_PATH)
		return readiness(options, logger);
	if (path.startsWith(API_PATH_PREFIX)) {
		const startup = options.startupStatus();
		if (startup !== "started")
			return problemResponse(
				REQUEST_PROBLEMS.instance_not_ready[startup],
				correlationId,
			);
		if (path === MCP_PATH) return answerMcpRequest(options.api, incoming);
		return answerApiRequest(options.api, incoming);
	}
	return problemResponse(REQUEST_PROBLEMS.route_not_found, correlationId);
}

async function readiness(
	{ checkDatabase, startupStatus }: ServerOptions,
	logger: Logger,
): Promise<Response> {
	const startup = startupStatus();
	if (startup === "starting") {
		logger.debug("not ready: instance starting");
		return notReady();
	}
	if (startup === "failed") {
		logger.warn("not ready: instance failed to start");
		return notReady();
	}
	const database = await checkDatabase(logger);
	if (database.reachable) return Response.json({ status: HEALTH_STATUS.ready });
	logger.warn("not ready: database unreachable", { reason: database.reason });
	return notReady();
}

function notReady(): Response {
	return Response.json({ status: HEALTH_STATUS.notReady }, { status: 503 });
}
