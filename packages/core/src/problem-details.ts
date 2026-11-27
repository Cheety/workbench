import type { FailureKind, OperationFailure } from "./operation-pipeline.ts";
import type { ValidationIssue } from "./schema-validation.ts";

export type ProblemDetails = {
	readonly type: string;
	readonly title: string;
	readonly status: number;
	readonly detail: string;
	readonly code: string;
	readonly correlationId: string;
	readonly issues: readonly ValidationIssue[];
};

const PROBLEM_TYPE_PREFIX = "urn:workbench:problem:";

const STATUS_OF: Record<
	FailureKind,
	{ readonly status: number; readonly title: string }
> = {
	invalid_input: { status: 400, title: "Bad Request" },
	not_found: { status: 404, title: "Not Found" },
	conflict: { status: 409, title: "Conflict" },
	rejected: { status: 422, title: "Unprocessable Content" },
	internal: { status: 500, title: "Internal Server Error" },
};

export function toProblemDetails(
	failure: OperationFailure,
	correlationId: string,
): ProblemDetails {
	return {
		type: `${PROBLEM_TYPE_PREFIX}${failure.code}`,
		...STATUS_OF[failure.kind],
		detail: failure.detail,
		code: failure.code,
		correlationId,
		issues: failure.issues,
	};
}
