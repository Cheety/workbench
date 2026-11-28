import type { FailureKind } from "./operation-pipeline.ts";
import type { ValidationIssue } from "./schema-validation.ts";

export type ProblemKind =
	| FailureKind
	| "unauthenticated"
	| "method_not_allowed"
	| "too_large"
	| "not_ready";

export type Problem = {
	readonly code: string;
	readonly kind: ProblemKind;
	readonly detail: string;
	readonly issues: readonly ValidationIssue[];
};

export type ProblemDetails = {
	readonly type: string;
	readonly title: string;
	readonly status: number;
	readonly detail: string;
	readonly code: string;
	readonly correlationId: string;
	readonly issues: readonly ValidationIssue[];
};

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export const MAX_BODY_BYTES = 1024 * 1024;

export type UnreadyStartupStatus = "starting" | "failed";

type RequestProblemCode =
	| "route_not_found"
	| "method_not_allowed"
	| "unauthenticated"
	| "malformed_path"
	| "invalid_workspace_id"
	| "invalid_input"
	| "body_too_large"
	| "instance_not_ready"
	| "internal_error";

type RequestProblem<C extends RequestProblemCode> = Problem & {
	readonly code: C;
};

type RequestProblemCatalogue = {
	readonly [C in Exclude<
		RequestProblemCode,
		"instance_not_ready"
	>]: RequestProblem<C>;
} & {
	readonly instance_not_ready: Readonly<
		Record<UnreadyStartupStatus, RequestProblem<"instance_not_ready">>
	>;
};

function requestProblem<C extends RequestProblemCode>(
	code: C,
	kind: ProblemKind,
	detail: string,
): RequestProblem<C> {
	return { code, kind, detail, issues: [] };
}

export const REQUEST_PROBLEMS = {
	route_not_found: requestProblem(
		"route_not_found",
		"not_found",
		"no route matches the method and path of the request",
	),
	method_not_allowed: requestProblem(
		"method_not_allowed",
		"method_not_allowed",
		"the operation path only accepts POST",
	),
	unauthenticated: requestProblem(
		"unauthenticated",
		"unauthenticated",
		"the request needs a valid API token as a bearer token",
	),
	malformed_path: requestProblem(
		"malformed_path",
		"invalid_input",
		"the path of the request is not valid percent-encoding",
	),
	invalid_workspace_id: requestProblem(
		"invalid_workspace_id",
		"invalid_input",
		"the workspace in the path is not a UUID",
	),
	invalid_input: requestProblem(
		"invalid_input",
		"invalid_input",
		"the request body is not JSON",
	),
	body_too_large: requestProblem(
		"body_too_large",
		"too_large",
		`the request body exceeds ${MAX_BODY_BYTES} bytes`,
	),
	instance_not_ready: {
		starting: requestProblem(
			"instance_not_ready",
			"not_ready",
			"the instance is still starting",
		),
		failed: requestProblem(
			"instance_not_ready",
			"not_ready",
			"the instance failed to start",
		),
	},
	internal_error: requestProblem(
		"internal_error",
		"internal",
		"the request failed for an internal reason",
	),
} as const satisfies RequestProblemCatalogue;

const PROBLEM_TYPE_PREFIX = "urn:workbench:problem:";

const STATUS_OF: Record<
	ProblemKind,
	{ readonly status: number; readonly title: string }
> = {
	invalid_input: { status: 400, title: "Bad Request" },
	unauthenticated: { status: 401, title: "Unauthorized" },
	forbidden: { status: 403, title: "Forbidden" },
	not_found: { status: 404, title: "Not Found" },
	method_not_allowed: { status: 405, title: "Method Not Allowed" },
	conflict: { status: 409, title: "Conflict" },
	too_large: { status: 413, title: "Content Too Large" },
	rejected: { status: 422, title: "Unprocessable Content" },
	internal: { status: 500, title: "Internal Server Error" },
	not_ready: { status: 503, title: "Service Unavailable" },
};

export function statusOf(kind: ProblemKind): number {
	return STATUS_OF[kind].status;
}

export function toProblemDetails(
	problem: Problem,
	correlationId: string,
): ProblemDetails {
	return {
		type: `${PROBLEM_TYPE_PREFIX}${problem.code}`,
		...STATUS_OF[problem.kind],
		detail: problem.detail,
		code: problem.code,
		correlationId,
		issues: problem.issues,
	};
}

export function problemResponse(
	problem: Problem,
	correlationId: string,
): Response {
	const details = toProblemDetails(problem, correlationId);
	return Response.json(details, {
		status: details.status,
		headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
	});
}
