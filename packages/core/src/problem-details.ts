import type { FailureKind } from "./operation-pipeline.ts";
import type { ValidationIssue } from "./schema-validation.ts";

export type ProblemKind = FailureKind | "unauthenticated" | "not_ready";

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

export const ROUTE_NOT_FOUND: Problem = {
	code: "route_not_found",
	kind: "not_found",
	detail: "no route matches the method and path of the request",
	issues: [],
};

const PROBLEM_TYPE_PREFIX = "urn:workbench:problem:";

const STATUS_OF: Record<
	ProblemKind,
	{ readonly status: number; readonly title: string }
> = {
	invalid_input: { status: 400, title: "Bad Request" },
	unauthenticated: { status: 401, title: "Unauthorized" },
	not_found: { status: 404, title: "Not Found" },
	conflict: { status: 409, title: "Conflict" },
	rejected: { status: 422, title: "Unprocessable Content" },
	internal: { status: 500, title: "Internal Server Error" },
	not_ready: { status: 503, title: "Service Unavailable" },
};

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
