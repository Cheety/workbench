import { createLogger, type Logger } from "../logger.ts";

export type LogEntry = Record<string, unknown>;

const FIXED_NOW = new Date("2026-11-26T08:00:00.000Z");

export function recordingLogger(now: () => Date = () => FIXED_NOW): {
	readonly logger: Logger;
	readonly entries: LogEntry[];
} {
	const entries: LogEntry[] = [];
	const logger = createLogger({
		level: "debug",
		now,
		write: (line) => entries.push(JSON.parse(line)),
	});
	return { logger, entries };
}
