import { UNKNOWN_FAILURE_REASON } from "./failure-reason.ts";

export function systemFailureReason(error: unknown): string {
	if (!(error instanceof Error) || !("code" in error))
		return UNKNOWN_FAILURE_REASON;
	return typeof error.code === "string" ? error.code : UNKNOWN_FAILURE_REASON;
}
