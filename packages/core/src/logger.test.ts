import { describe, expect, test } from "bun:test";
import { Secret } from "./config.ts";
import { createLogger, type LogLevel } from "./logger.ts";

function captureLogger(level: LogLevel) {
	const lines: string[] = [];
	const logger = createLogger({
		level,
		now: () => new Date("2026-11-26T08:15:30.123Z"),
		write: (line) => lines.push(line),
	});
	return { logger, entries: () => lines.map((line) => JSON.parse(line)) };
}

describe("createLogger", () => {
	test("writes one JSON object per entry with time, level, message and fields", () => {
		const { logger, entries } = captureLogger("info");

		logger.info("server started", { port: 3000 });

		expect(entries()).toEqual([
			{
				time: "2026-11-26T08:15:30.123Z",
				level: "info",
				message: "server started",
				port: 3000,
			},
		]);
	});

	test("drops entries below the configured level", () => {
		const { logger, entries } = captureLogger("warn");

		logger.debug("a");
		logger.info("b");
		logger.warn("c");
		logger.error("d");

		expect(entries().map((entry) => entry.level)).toEqual(["warn", "error"]);
	});

	test("adds bound fields to every entry of a derived logger", () => {
		const { logger, entries } = captureLogger("info");

		logger
			.with({ correlationId: "req-1" })
			.info("request completed", { status: 200 });
		logger.info("unrelated");

		expect(entries()[0]).toMatchObject({ correlationId: "req-1", status: 200 });
		expect(entries()[1]).not.toHaveProperty("correlationId");
	});

	test("does not let fields overwrite time, level or message", () => {
		const { logger, entries } = captureLogger("info");

		logger.info("real", { message: "forged", level: "debug", time: "never" });

		expect(entries()[0]).toMatchObject({
			time: "2026-11-26T08:15:30.123Z",
			level: "info",
			message: "real",
		});
	});

	test("redacts secrets passed as fields", () => {
		const { logger, entries } = captureLogger("info");

		logger.info("connecting", {
			databaseUrl: new Secret("postgres://u:s3cr3t-pass@h/db"),
		});

		expect(JSON.stringify(entries())).not.toContain("s3cr3t-pass");
	});
});
