import type { Logger } from "./logger.ts";
import type { DatabaseCheck } from "./postgres.ts";

export const CORRELATION_ID_HEADER = "X-Correlation-ID";

const VALID_CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const HEALTH_PATH_PREFIX = "/health/";
const LIVENESS_PATH = "/health/live";
const READINESS_PATH = "/health/ready";

export type ServerOptions = {
	/** TCP port to listen on; 0 picks a free one. */
	readonly port: number;
	readonly logger: Logger;
	readonly checkDatabase: DatabaseCheck;
	/** Generates the correlation ID for requests that do not bring a valid one. */
	readonly newCorrelationId: () => string;
};

export type RunningServer = {
	readonly port: number;
	/** Stops listening and closes open connections. */
	stop(): Promise<void>;
};

/**
 * Starts the HTTP server. It does not need the database to start: liveness
 * (`/health/live`) reports on the process only, readiness (`/health/ready`)
 * answers 503 while the database is unreachable.
 */
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
		request.method,
		path,
		options.checkDatabase,
		logger,
	).catch((error: unknown) => {
		logger.error("request failed", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return problem(500, "Internal Server Error");
	});
	response.headers.set(CORRELATION_ID_HEADER, correlationId);
	const entry = { method: request.method, path, status: response.status };
	// Health probes arrive every few seconds; at info they would drown the log.
	if (path.startsWith(HEALTH_PATH_PREFIX))
		logger.debug("request completed", entry);
	else logger.info("request completed", entry);
	return response;
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
	checkDatabase: DatabaseCheck,
	logger: Logger,
): Promise<Response> {
	if (method === "GET" && path === LIVENESS_PATH)
		return Response.json({ status: "alive" });
	if (method === "GET" && path === READINESS_PATH)
		return readiness(checkDatabase, logger);
	return problem(404, "Not Found");
}

async function readiness(
	checkDatabase: DatabaseCheck,
	logger: Logger,
): Promise<Response> {
	const database = await checkDatabase();
	if (database.reachable) return Response.json({ status: "ready" });
	logger.warn("not ready: database unreachable", { reason: database.reason });
	return Response.json({ status: "not_ready" }, { status: 503 });
}

/** An RFC 9457 problem response without internals. */
function problem(status: number, title: string): Response {
	return Response.json(
		{ type: "about:blank", title, status },
		{ status, headers: { "Content-Type": "application/problem+json" } },
	);
}
