import { describe, expect, test } from "bun:test";
import { reportFailedStart, shutDown, shutDownInstance } from "./shutdown.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

describe("shutdown", () => {
	test("exits with 0 and logs nothing when the server stops", async () => {
		const { logger, entries } = recordingLogger();

		const exitCode = await shutDown({ stop: async () => {} }, logger);

		expect(exitCode).toBe(0);
		expect(entries).toEqual([]);
	});

	test("exits with 1 and one log entry without internals when the server fails to stop", async () => {
		const { logger, entries } = recordingLogger();
		const failure = Object.assign(new Error("s3cr3t-detail"), {
			code: "ECONNRESET",
		});

		const exitCode = await shutDown(
			{ stop: () => Promise.reject(failure) },
			logger,
		);

		expect(exitCode).toBe(1);
		expect(entries).toEqual([
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "error",
				message: "server failed to stop",
				reason: "ECONNRESET",
			},
		]);
	});

	test("reports an unknown reason when the failure carries no system error code", async () => {
		const { logger, entries } = recordingLogger();

		const exitCode = await shutDown(
			{ stop: () => Promise.reject("s3cr3t-detail") },
			logger,
		);

		expect(exitCode).toBe(1);
		expect(entries).toEqual([
			expect.objectContaining({
				message: "server failed to stop",
				reason: "unknown",
			}),
		]);
	});
});

describe("instance shutdown", () => {
	test("stops the server, then the event delivery, deactivates the plugins, closes the database connections and exits with 0", async () => {
		const { logger } = recordingLogger();
		const journal: string[] = [];

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				eventDelivery: {
					stop: async () => {
						journal.push("event delivery stopped");
					},
				},
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
			"event delivery stopped",
			"plugins deactivated",
			"database closed",
		]);
	});

	test("reports it and exits with 1 when the database connections fail to close", async () => {
		const { logger, entries } = recordingLogger();

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				eventDelivery: { stop: async () => {} },
				database: { close: () => Promise.reject(new Error("socket hang")) },
				server: { stop: async () => {} },
				plugins: { deactivate: async () => "clean" },
			},
			logger,
		);

		expect(exitCode).toBe(1);
		expect(entries).toEqual([
			expect.objectContaining({
				level: "error",
				message: "database connections failed to close",
				error: expect.objectContaining({ message: "socket hang" }),
			}),
		]);
	});

	test("reports it, exits with 1 and still deactivates the plugins when the event delivery fails to stop", async () => {
		const { logger, entries } = recordingLogger();
		const journal: string[] = [];

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				eventDelivery: { stop: () => Promise.reject(new Error("stuck")) },
				database: {
					close: async () => {
						journal.push("database closed");
					},
				},
				server: { stop: async () => {} },
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
		expect(journal).toEqual(["plugins deactivated", "database closed"]);
		expect(entries).toEqual([
			expect.objectContaining({
				level: "error",
				message: "event delivery failed to stop",
				error: expect.objectContaining({ message: "stuck" }),
			}),
		]);
	});

	test("exits with 1 when a plugin could not be deactivated", async () => {
		const { logger } = recordingLogger();

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				eventDelivery: { stop: async () => {} },
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
				eventDelivery: { stop: async () => {} },
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
				eventDelivery: { stop: async () => {} },
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
		const { logger, entries } = recordingLogger();
		const journal: string[] = [];

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				eventDelivery: { stop: async () => {} },
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
		expect(entries).toEqual([
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
		const { logger, entries } = recordingLogger();

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				eventDelivery: { stop: async () => {} },
				database: { close: async () => {} },
				server: { stop: async () => {} },
				plugins: {
					deactivate: () => Promise.reject(new TypeError("kernel defect")),
				},
			},
			logger,
		);

		expect(exitCode).toBe(1);
		expect(entries).toEqual([
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
				eventDelivery: { stop: async () => {} },
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
		const { logger, entries } = recordingLogger();

		await reportFailedStart(
			Promise.reject(new TypeError("kernel defect")),
			logger,
		);

		expect(entries).toEqual([
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
		const { logger, entries } = recordingLogger();
		const journal: string[] = [];
		const plugins = reportFailedStart(
			Promise.reject(new TypeError("kernel defect")),
			logger,
		);

		const exitCode = await shutDownInstance(
			{
				stopStartingPlugins: () => {},
				eventDelivery: { stop: async () => {} },
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
		expect(entries.map((entry) => entry.message)).toEqual([
			"plugins failed to start",
		]);
	});

	test("reports nothing for plugins that started and leaves their deactivation to them", async () => {
		const { logger, entries } = recordingLogger();
		const journal: string[] = [];

		const plugins = await reportFailedStart(
			Promise.resolve({
				deactivate: async () => {
					journal.push("plugins deactivated");
					return "clean" as const;
				},
			}),
			logger,
		);
		const outcome = await plugins.deactivate();

		expect(outcome).toBe("clean");
		expect(journal).toEqual(["plugins deactivated"]);
		expect(entries).toEqual([]);
	});
});
