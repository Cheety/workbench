export const UNKNOWN_FAILURE_REASON = "unknown";

export function errorName(error: unknown): string {
	return error instanceof Error ? error.name : UNKNOWN_FAILURE_REASON;
}
