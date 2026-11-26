export const UNKNOWN_FAILURE_REASON = "unknown";

/** What was thrown, as the log records it. */
export type ThrownError = {
	readonly name: string;
	readonly message: string;
	readonly stack?: string;
};

/** Anything can be thrown, so a value that is no `Error` is named "unknown". */
export function describeThrown(thrown: unknown): ThrownError {
	if (thrown instanceof Error) {
		const { name, message, stack } = thrown;
		return stack === undefined ? { name, message } : { name, message, stack };
	}
	return {
		name: UNKNOWN_FAILURE_REASON,
		message:
			typeof thrown === "string" ? thrown : "the thrown value is not an Error",
	};
}

export function summarize(error: ThrownError): string {
	return `${error.name}: ${error.message}`;
}
