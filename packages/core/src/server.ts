import { UNKNOWN_FAILURE_REASON } from "./failure-reason.ts";
import type { Logger } from "./logger.ts";
import type { DatabaseCheck } from "./postgres.ts";

export const CORRELATION_ID_HEADER = "X-Correlation-ID";

const VALID_CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const HEALTH_PATH_PREFIX = "/health/";
const LIVENESS_PATH = "/health/live";
const READINESS_PATH = "/health/ready";

const HEALTH_STATUS = {
	alive: "alive",
	ready: "ready",
	notReady: "not_ready",
} as const;

export type StartupStatus = "starting" | "started" | "failed";

export type ServerOptions = {
	readonly port: number;
	readonly logger: Logger;
	readonly checkDatabase: DatabaseCheck;
	readonly newCorrelationId: () => string;
	readonly startupStatus: () => StartupStatus;
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
	const response = await route(request.method, path, options, logger).catch(
		(error: unknown) => {
			logger.error("request failed", { error: errorName(error) });
			return problem(500, "Internal Server Error");
		},
	);
	response.headers.set(CORRELATION_ID_HEADER, correlationId);
	const entry = { method: request.method, path, status: response.status };
	const level = path.startsWith(HEALTH_PATH_PREFIX) ? "debug" : "info";
	logger[level]("request completed", entry);
	return response;
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : UNKNOWN_FAILURE_REASON;
}

function acceptCorrelationId(request: Request): string | undefined {
	const incoming = request.headers.get(CORRELATION_ID_HEADER);
	return incoming !== null && VALID_CORRELATION_ID.test(incoming)
		? incoming
		: undefined;
}

async function route(
	method: string,
	path: string,
	options: ServerOptions,
	logger: Logger,
): Promise<Response> {
	if (method === "GET" && path === LIVENESS_PATH)
		return Response.json({ status: HEALTH_STATUS.alive });
	if (method === "GET" && path === READINESS_PATH)
		return readiness(options, logger);
	return problem(404, "Not Found");
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

function problem(status: number, title: string): Response {
	return Response.json(
		{ type: "about:blank", title, status },
		{ status, headers: { "Content-Type": "application/problem+json" } },
	);
}
