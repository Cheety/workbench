export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

export type Logger = {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	with(fields: LogFields): Logger;
};

export type LoggerOptions = {
	readonly level: LogLevel;
	readonly now: () => Date;
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
		const reserved = { time: options.now().toISOString(), level, message };
		const context = withoutKeysOf(reserved, { ...bound, ...fields });
		options.write(JSON.stringify({ ...reserved, ...context }));
	};
	return {
		debug: (message, fields) => log("debug", message, fields),
		info: (message, fields) => log("info", message, fields),
		warn: (message, fields) => log("warn", message, fields),
		error: (message, fields) => log("error", message, fields),
		with: (fields) => bindLogger(options, { ...bound, ...fields }),
	};
}

function withoutKeysOf(reserved: LogFields, fields: LogFields): LogFields {
	return Object.fromEntries(
		Object.entries(fields).filter(([key]) => !Object.hasOwn(reserved, key)),
	);
}
