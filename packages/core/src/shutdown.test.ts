import { describe, expect, test } from "bun:test";
import { createLogger } from "./logger.ts";
import { shutDown } from "./shutdown.ts";

function recordingLogger() {
	const lines: string[] = [];
	const logger = createLogger({
		level: "debug",
		now: () => new Date("2026-11-26T08:00:00.000Z"),
		write: (line) => lines.push(line),
	});
	return { logger, lines };
}

describe("shutdown", () => {
	test("exits with 0 and logs nothing when the server stops", async () => {
		const { logger, lines } = recordingLogger();

		const exitCode = await shutDown({ stop: async () => {} }, logger);

		expect(exitCode).toBe(0);
		expect(lines).toEqual([]);
	});

	test("exits with 1 and one log entry without internals when the server fails to stop", async () => {
		const { logger, lines } = recordingLogger();
		const failure = Object.assign(new Error("s3cr3t-detail"), {
			code: "ECONNRESET",
		});

		const exitCode = await shutDown(
			{ stop: () => Promise.reject(failure) },
			logger,
		);

		expect(exitCode).toBe(1);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "error",
				message: "server failed to stop",
				reason: "ECONNRESET",
			},
		]);
	});

	test("reports an unknown reason when the failure carries no system error code", async () => {
		const { logger, lines } = recordingLogger();

		const exitCode = await shutDown(
			{ stop: () => Promise.reject("s3cr3t-detail") },
			logger,
		);

		expect(exitCode).toBe(1);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({
				message: "server failed to stop",
				reason: "unknown",
			}),
		]);
	});
});
