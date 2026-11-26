export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Writes structured log entries: one JSON object per line with `time`
 * (RFC 3339, UTC), `level`, `message` and the given fields. Fields must be
 * JSON-serializable; secrets belong in a `Secret`, which serializes redacted.
 */
export type Logger = {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	/** Returns a logger that adds the given fields to every entry. */
	with(fields: LogFields): Logger;
};

export type LoggerOptions = {
	/** Entries below this level are dropped. */
	readonly level: LogLevel;
	readonly now: () => Date;
	/** Receives one serialized entry without a trailing newline. */
	readonly write: (line: string) => void;
};

export function createLogger(options: LoggerOptions): Logger {
	return bindLogger(options, {});
}

function bindLogger(options: LoggerOptions, bound: LogFields): Logger {
	const threshold = LOG_LEVELS.indexOf(options.level);
	const log = (
		level: LogLevel,
		message: string,
		fields: LogFields = {},
	): void => {
		if (LOG_LEVELS.indexOf(level) < threshold) return;
		options.write(
			JSON.stringify({
				...bound,
				...fields,
				time: options.now().toISOString(),
				level,
				message,
			}),
		);
	};
	return {
		debug: (message, fields) => log("debug", message, fields),
		info: (message, fields) => log("info", message, fields),
		warn: (message, fields) => log("warn", message, fields),
		error: (message, fields) => log("error", message, fields),
		with: (fields) => bindLogger(options, { ...bound, ...fields }),
	};
}
