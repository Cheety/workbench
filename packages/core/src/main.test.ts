import { describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL } from "./testing/postgres.ts";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

function spawnInstance(env: Record<string, string>) {
	return Bun.spawn([process.execPath, MAIN], {
		env: { PATH: process.env.PATH ?? "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
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
