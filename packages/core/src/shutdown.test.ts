import { describe, expect, test } from "bun:test";
import { createLogger } from "./logger.ts";
import { reportFailedStart, shutDown, shutDownInstance } from "./shutdown.ts";

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

describe("instance shutdown", () => {
	test("stops the server, deactivates the plugins, closes the database connections and exits with 0", async () => {
		const { logger } = recordingLogger();
		const journal: string[] = [];

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				database: {
					close: async () => {
						journal.push("database closed");
					},
				},
				server: {
					stop: async () => {
						journal.push("server stopped");
					},
				},
				plugins: {
					deactivate: async () => {
						journal.push("plugins deactivated");
						return "clean";
					},
				},
			},
			logger,
		);

		expect(exitCode).toBe(0);
		expect(journal).toEqual([
			"server stopped",
			"plugins deactivated",
			"database closed",
		]);
	});

	test("reports it and exits with 1 when the database connections fail to close", async () => {
		const { logger, lines } = recordingLogger();

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				database: { close: () => Promise.reject(new Error("socket hang")) },
				server: { stop: async () => {} },
				plugins: { deactivate: async () => "clean" },
			},
			logger,
		);

		expect(exitCode).toBe(1);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({
				level: "error",
				message: "database connections failed to close",
				error: expect.objectContaining({ message: "socket hang" }),
			}),
		]);
	});

	test("exits with 1 when a plugin could not be deactivated", async () => {
		const { logger } = recordingLogger();

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				database: { close: async () => {} },
				server: { stop: async () => {} },
				plugins: { deactivate: async () => "incomplete" },
			},
			logger,
		);

		expect(exitCode).toBe(1);
	});

	test("deactivates the plugins even when the server fails to stop", async () => {
		const { logger } = recordingLogger();
		const journal: string[] = [];

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				database: { close: async () => {} },
				server: { stop: () => Promise.reject(new Error("stuck")) },
				plugins: {
					deactivate: async () => {
						journal.push("plugins deactivated");
						return "clean";
					},
				},
			},
			logger,
		);

		expect(exitCode).toBe(1);
		expect(journal).toEqual(["plugins deactivated"]);
	});

	test("waits for plugins that are still starting and deactivates them", async () => {
		const { logger } = recordingLogger();
		const journal: string[] = [];
		const starting = Promise.withResolvers<{
			deactivate: () => Promise<"clean">;
		}>();

		const shuttingDown = shutDownInstance(
			{
				stopStartingPlugins: () => {},
				database: { close: async () => {} },
				server: { stop: async () => {} },
				plugins: starting.promise,
			},
			logger,
		);
		starting.resolve({
			deactivate: async () => {
				journal.push("plugins deactivated");
				return "clean";
			},
		});
		const exitCode = await shuttingDown;

		expect(exitCode).toBe(0);
		expect(journal).toEqual(["plugins deactivated"]);
	});

	test("stops the server, reports it and exits with 1 when the plugins failed to start", async () => {
		const { logger, lines } = recordingLogger();
		const journal: string[] = [];

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				database: { close: async () => {} },
				server: {
					stop: async () => {
						journal.push("server stopped");
					},
				},
				plugins: Promise.reject(new TypeError("kernel defect")),
			},
			logger,
		);

		expect(exitCode).toBe(1);
		expect(journal).toEqual(["server stopped"]);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({
				level: "error",
				message: "plugins failed to shut down",
				error: expect.objectContaining({
					name: "TypeError",
					message: "kernel defect",
				}),
			}),
		]);
	});

	test("reports it and exits with 1 when deactivating the plugins fails as a whole", async () => {
		const { logger, lines } = recordingLogger();

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				database: { close: async () => {} },
				server: { stop: async () => {} },
				plugins: {
					deactivate: () => Promise.reject(new TypeError("kernel defect")),
				},
			},
			logger,
		);

		expect(exitCode).toBe(1);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({
				level: "error",
				message: "plugins failed to shut down",
				error: expect.objectContaining({ message: "kernel defect" }),
			}),
		]);
	});

	test("tells plugins that are still starting to stop before it waits for them", async () => {
		const { logger } = recordingLogger();
		const journal: string[] = [];
		const starting = Promise.withResolvers<{
			deactivate: () => Promise<"clean">;
		}>();

		const exitCode = await shutDownInstance(
			{
				database: { close: async () => {} },
				stopStartingPlugins: () => {
					journal.push("start stopped");
					starting.resolve({
						deactivate: async () => {
							journal.push("plugins deactivated");
							return "clean";
						},
					});
				},
				server: {
					stop: async () => {
						journal.push("server stopped");
					},
				},
				plugins: starting.promise,
			},
			logger,
		);

		expect(exitCode).toBe(0);
		expect(journal).toEqual([
			"start stopped",
			"server stopped",
			"plugins deactivated",
		]);
	});
});

describe("failed plugin start", () => {
	test("is reported when it fails, without waiting for a shutdown", async () => {
		const { logger, lines } = recordingLogger();

		await reportFailedStart(
			Promise.reject(new TypeError("kernel defect")),
			logger,
		);

		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({
				level: "error",
				message: "plugins failed to start",
				error: {
					name: "TypeError",
					message: "kernel defect",
					stack: expect.stringContaining("shutdown.test.ts"),
				},
			}),
		]);
	});

	test("is not reported a second time by the shutdown, which exits with 1", async () => {
		const { logger, lines } = recordingLogger();
		const journal: string[] = [];
		const plugins = reportFailedStart(
			Promise.reject(new TypeError("kernel defect")),
			logger,
		);

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				database: { close: async () => {} },
				server: {
					stop: async () => {
						journal.push("server stopped");
					},
				},
				plugins,
			},
			logger,
		);

		expect(exitCode).toBe(1);
		expect(journal).toEqual(["server stopped"]);
		expect(lines.map((line) => JSON.parse(line).message as unknown)).toEqual([
			"plugins failed to start",
		]);
	});

	test("leaves plugins that started as they are", async () => {
		const { logger, lines } = recordingLogger();
		const started = { deactivate: async () => "clean" as const };

		const plugins = await reportFailedStart(Promise.resolve(started), logger);

		expect(plugins).toBe(started);
		expect(lines).toEqual([]);
	});
});
