const UNKNOWN_FAILURE = "unknown";

export function systemFailureReason(error: unknown): string {
	if (!(error instanceof Error) || !("code" in error)) return UNKNOWN_FAILURE;
	return typeof error.code === "string" ? error.code : UNKNOWN_FAILURE;
}
