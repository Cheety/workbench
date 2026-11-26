import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess, TCPSocketListener } from "bun";
import { TEST_DATABASE_URL } from "./testing/postgres.ts";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

const instances: Subprocess[] = [];
let occupiedPort: TCPSocketListener | undefined;

afterEach(async () => {
	for (const instance of instances.splice(0)) {
		instance.kill("SIGKILL");
		await instance.exited;
	}
	occupiedPort?.stop(true);
	occupiedPort = undefined;
});

function spawnInstance(env: Record<string, string>) {
	const instance = Bun.spawn([process.execPath, MAIN], {
		env: { PATH: process.env.PATH ?? "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	instances.push(instance);
	return instance;
}

function occupyPort(): number {
	occupiedPort = Bun.listen({
		hostname: "0.0.0.0",
		port: 0,
		socket: { data() {} },
	});
	return occupiedPort.port;
}

async function readFirstLine(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of stream) {
		buffered += decoder.decode(chunk, { stream: true });
		const end = buffered.indexOf("\n");
		if (end !== -1) return buffered.slice(0, end);
	}
	throw new Error(`stream ended before a full line: ${buffered}`);
}

type LogEntry = Record<string, unknown>;

// Reads the log across several calls; iterating the stream directly would
// cancel it at the first early return.
function readLog(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const nextEntry = async (): Promise<LogEntry | undefined> => {
		for (;;) {
			const end = buffered.indexOf("\n");
			if (end !== -1) {
				const line = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				return JSON.parse(line);
			}
			const { done, value } = await reader.read();
			if (done) return undefined;
			buffered += decoder.decode(value, { stream: true });
		}
	};
	const collect = async (lastMessage?: string): Promise<LogEntry[]> => {
		const entries: LogEntry[] = [];
		for (;;) {
			const entry = await nextEntry();
			if (entry === undefined) {
				if (lastMessage === undefined) return entries;
				throw new Error(
					`log ended before "${lastMessage}": ${JSON.stringify(entries)}`,
				);
			}
			entries.push(entry);
			if (entry.message === lastMessage) return entries;
		}
	};
	return {
		until: (message: string) => collect(message),
		rest: () => collect(),
	};
}

describe("instance start", () => {
	test("aborts and names the variable when a required one is missing", async () => {
		const instance = spawnInstance({});

		const exitCode = await instance.exited;
		const stderr = await new Response(instance.stderr).text();

		expect(exitCode).toBe(1);
		expect(JSON.parse(stderr)).toMatchObject({
			level: "error",
			message: "invalid configuration, not starting",
			issues: [{ variable: "DATABASE_URL", problem: "is required" }],
		});
	});

	test("aborts without printing the value of an invalid secret", async () => {
		const instance = spawnInstance({
			DATABASE_URL: "mysql://workbench:s3cr3t-pass@db.internal/workbench",
			PORT: "not-a-port",
		});

		const exitCode = await instance.exited;
		const output =
			(await new Response(instance.stderr).text()) +
			(await new Response(instance.stdout).text());

		expect(exitCode).toBe(1);
		expect(output).toContain("DATABASE_URL");
		expect(output).toContain("PORT");
		expect(output).not.toContain("s3cr3t-pass");
	});

	test("aborts with one log entry and no internals when the port is in use", async () => {
		const port = occupyPort();
		const instance = spawnInstance({
			DATABASE_URL: TEST_DATABASE_URL,
			PORT: String(port),
		});

		const exitCode = await instance.exited;
		const stdout = await new Response(instance.stdout).text();
		const stderr = await new Response(instance.stderr).text();

		expect(exitCode).toBe(1);
		expect(stderr).toBe("");
		expect(
			stdout
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([
			expect.objectContaining({
				level: "error",
				message: "server failed to start",
				port,
				reason: "EADDRINUSE",
			}),
		]);
	});

	test("serves health checks and shuts down cleanly on SIGTERM", async () => {
		const instance = spawnInstance({
			DATABASE_URL: TEST_DATABASE_URL,
			PORT: "0",
		});
		const started = JSON.parse(await readFirstLine(instance.stdout));

		const ready = await fetch(`http://127.0.0.1:${started.port}/health/ready`);
		instance.kill("SIGTERM");
		const exitCode = await instance.exited;

		expect(started).toMatchObject({ level: "info", message: "server started" });
		expect(ready.status).toBe(200);
		expect(ready.headers.get("X-Correlation-ID")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(exitCode).toBe(0);
	});
});

describe("plugins of an instance", () => {
	test("activates the reference plugin the instance config enables and deactivates it on shutdown", async () => {
		const instance = spawnInstance({
			DATABASE_URL: TEST_DATABASE_URL,
			PORT: "0",
			PLUGINS: "reference",
		});
		const log = readLog(instance.stdout);

		const startup = await log.until("plugins started");
		instance.kill("SIGTERM");
		const exitCode = await instance.exited;
		const shutdown = await log.rest();

		expect(startup).toContainEqual(
			expect.objectContaining({
				level: "info",
				message: "plugin activated",
				plugin: "reference",
			}),
		);
		expect(startup.at(-1)).toMatchObject({
			active: ["reference"],
			notLoaded: [],
		});
		expect(shutdown).toContainEqual(
			expect.objectContaining({
				message: "plugin deactivated",
				plugin: "reference",
			}),
		);
		expect(exitCode).toBe(0);
	});

	test("discovers the reference plugin but leaves it inactive when the instance config does not enable it", async () => {
		const instance = spawnInstance({
			DATABASE_URL: TEST_DATABASE_URL,
			PORT: "0",
		});

		const startup = await readLog(instance.stdout).until("plugins started");

		expect(startup).toContainEqual(
			expect.objectContaining({
				message: "plugins discovered",
				packages: ["@workbench/plugin-reference"],
			}),
		);
		expect(startup.map((entry) => entry.message)).not.toContain(
			"plugin activated",
		);
		expect(startup.at(-1)).toMatchObject({ active: [], notLoaded: [] });
	});

	test("keeps running and tells the operator why an enabled plugin was not loaded", async () => {
		const instance = spawnInstance({
			DATABASE_URL: TEST_DATABASE_URL,
			PORT: "0",
			PLUGINS: "ghost,reference",
		});

		const startup = await readLog(instance.stdout).until("plugins started");
		const live = await fetch(
			`http://127.0.0.1:${startup[0]?.port}/health/live`,
		);

		expect(startup).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin not loaded",
				plugin: "ghost",
				reason: "unknown_plugin",
				detail:
					'plugin "ghost" is enabled in the instance config, but no plugin package provides it',
			}),
		);
		expect(startup.at(-1)).toMatchObject({
			active: ["reference"],
			notLoaded: ["ghost"],
		});
		expect(live.status).toBe(200);
	});
});
