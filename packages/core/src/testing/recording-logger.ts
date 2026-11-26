import { createLogger, type Logger } from "../logger.ts";

export type LogEntry = Record<string, unknown>;

export function recordingLogger(): {
	readonly logger: Logger;
	readonly entries: LogEntry[];
} {
	const entries: LogEntry[] = [];
	const logger = createLogger({
		level: "debug",
		now: () => new Date("2026-11-26T08:00:00.000Z"),
		write: (line) => entries.push(JSON.parse(line)),
	});
	return { logger, entries };
}
