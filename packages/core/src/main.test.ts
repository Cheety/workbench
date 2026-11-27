import { afterEach, describe, expect, test } from "bun:test";
import { Glob, type Subprocess, type TCPSocketListener } from "bun";
import { z } from "zod";
import { CORE_MIGRATIONS_DIRECTORY } from "./schema-migrations.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	PostgresGate,
	TEST_DATABASE_URL,
} from "./testing/postgres.ts";
import { createWorkspace } from "./workspaces.ts";

const MAIN = new URL("./main.ts", import.meta.url).pathname;
const CREATE_SERVICE_ACCOUNT = new URL(
	"./create-service-account.ts",
	import.meta.url,
).pathname;
const REFERENCE_MIGRATIONS_DIRECTORY = new URL(
	"../../plugin-reference/migrations/",
	import.meta.url,
).pathname;

const instances: Subprocess[] = [];
const databases: FreshDatabase[] = [];
let occupiedPort: TCPSocketListener | undefined;
let openGate: PostgresGate | undefined;

afterEach(async () => {
	for (const instance of instances.splice(0)) {
		instance.kill("SIGKILL");
		await instance.exited;
	}
	occupiedPort?.stop(true);
	occupiedPort = undefined;
	openGate?.close();
	openGate = undefined;
	for (const database of databases.splice(0)) await database.drop();
});

async function freshDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	databases.push(database);
	return database;
}

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

type LogEntry = Record<string, unknown>;

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
		const database = await freshDatabase();
		const instance = spawnInstance({
			DATABASE_URL: database.url,
			PORT: "0",
		});
		const log = readLog(instance.stdout);
		const [started] = await log.until("instance started");

		const ready = await fetch(`http://127.0.0.1:${started?.port}/health/ready`);
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
		const database = await freshDatabase();
		const instance = spawnInstance({
			DATABASE_URL: database.url,
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
		const database = await freshDatabase();
		const instance = spawnInstance({
			DATABASE_URL: database.url,
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
		const database = await freshDatabase();
		const instance = spawnInstance({
			DATABASE_URL: database.url,
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

describe("migrations at start", () => {
	test("create the core schema and the table of the reference plugin on a fresh database before reporting ready", async () => {
		const database = await freshDatabase();
		const instance = spawnInstance({
			DATABASE_URL: database.url,
			PORT: "0",
			PLUGINS: "reference",
		});

		const startup = await readLog(instance.stdout).until("instance started");
		const ready = await fetch(
			`http://127.0.0.1:${startup[0]?.port}/health/ready`,
		);

		expect(startup).toContainEqual(
			expect.objectContaining({
				message: "migration applied",
				schema: "plugin_reference",
			}),
		);
		expect(ready.status).toBe(200);
		expect(
			await database.sql`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('core', 'plugin_reference')`,
		).toEqual(
			expect.arrayContaining([
				{ table_schema: "core", table_name: "migrations" },
				{ table_schema: "plugin_reference", table_name: "notes" },
			]),
		);
	});

	test("apply each migration once when two instances start against the same fresh database", async () => {
		const database = await freshDatabase();
		const env = { DATABASE_URL: database.url, PORT: "0", PLUGINS: "reference" };
		const first = spawnInstance(env);
		const second = spawnInstance(env);

		const startups = await Promise.all([
			readLog(first.stdout).until("instance started"),
			readLog(second.stdout).until("instance started"),
		]);

		const applied = startups
			.flat()
			.filter((entry) => entry.message === "migration applied")
			.map(({ schema, migration }) => ({ schema, migration }));
		const recorded = await database.sql<
			{ schema: string; migration: string }[]
		>`SELECT schema_name AS schema, migration FROM core.migrations`;
		const onDisk = [
			...(await Array.fromAsync(
				new Glob("*.sql").scan(CORE_MIGRATIONS_DIRECTORY),
			)),
			...(await Array.fromAsync(
				new Glob("*.sql").scan(REFERENCE_MIGRATIONS_DIRECTORY),
			)),
		];
		expect(applied).not.toBeEmpty();
		expect(applied).toHaveLength(recorded.length);
		expect(applied).toEqual(expect.arrayContaining([...recorded]));
		expect(recorded.map(({ migration }) => migration)).toEqual(
			expect.arrayContaining(onDisk),
		);
		expect(recorded).toHaveLength(onDisk.length);
	});

	test("migrate nothing when the instance starts again", async () => {
		const database = await freshDatabase();
		const env = { DATABASE_URL: database.url, PORT: "0", PLUGINS: "reference" };
		const first = spawnInstance(env);
		await readLog(first.stdout).until("instance started");
		first.kill("SIGTERM");
		await first.exited;
		const second = spawnInstance(env);

		const startup = await readLog(second.stdout).until("instance started");

		expect(startup.map((entry) => entry.message)).not.toContain(
			"migration applied",
		);
	});

	test("wait for an unreachable database, then migrate and report ready", async () => {
		const database = await freshDatabase();
		const gate = PostgresGate.create(database.url);
		openGate = gate;
		const instance = spawnInstance({
			DATABASE_URL: gate.url,
			PORT: "0",
			PLUGINS: "reference",
		});
		const log = readLog(instance.stdout);
		const waiting = await log.until("database unreachable, retrying");
		const whileWaiting = await fetch(
			`http://127.0.0.1:${waiting[0]?.port}/health/ready`,
		);
		gate.forward();

		await log.until("instance started");
		const ready = await fetch(
			`http://127.0.0.1:${waiting[0]?.port}/health/ready`,
		);

		expect(whileWaiting.status).toBe(503);
		expect(ready.status).toBe(200);
	});

	test("report not ready and log why when a migration fails", async () => {
		const database = await freshDatabase();
		await database.sql.unsafe(
			"CREATE SCHEMA plugin_reference; CREATE TABLE plugin_reference.notes (id bigint);",
		);
		const instance = spawnInstance({
			DATABASE_URL: database.url,
			PORT: "0",
			PLUGINS: "reference",
		});

		const startup = await readLog(instance.stdout).until(
			"instance failed to start",
		);
		const ready = await fetch(
			`http://127.0.0.1:${startup[0]?.port}/health/ready`,
		);

		expect(startup).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "migration failed",
				schema: "plugin_reference",
				migration: "0001_create_notes.sql",
			}),
		);
		expect(startup).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin not loaded",
				plugin: "reference",
				reason: "migration_failed",
			}),
		);
		expect(ready.status).toBe(503);
	});
});

describe("HTTP API of an instance", () => {
	test("runs the mutation and the query of the reference plugin for a token the operator created", async () => {
		const database = await freshDatabase();
		const command = Bun.spawn(
			[
				process.execPath,
				CREATE_SERVICE_ACCOUNT,
				"--name",
				"agent",
				"--valid-days",
				"1",
			],
			{
				env: { PATH: process.env.PATH ?? "", DATABASE_URL: database.url },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const { token } = z
			.object({ token: z.string() })
			.parse(JSON.parse(await new Response(command.stdout).text()));
		const workspace = "00000000-0000-4000-8000-00000000aaaa";
		await createWorkspace(database.sql, {
			id: workspace,
			name: "Alpha",
			createdAt: new Date("2026-11-26T08:00:00.000Z"),
		});
		const instance = spawnInstance({
			DATABASE_URL: database.url,
			PORT: "0",
			PLUGINS: "reference",
		});
		const log = readLog(instance.stdout);
		const [started] = await log.until("server started");
		await log.until("instance started");
		const call = (operation: string, input: unknown) =>
			fetch(
				`http://127.0.0.1:${started?.port}/api/workspaces/${workspace}/operations/${operation}`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${token}` },
					body: JSON.stringify(input),
				},
			);

		const created = await call("reference.createNote", { title: " Plan " });
		const listed = await call("reference.listNotes", { limit: 10 });

		expect(created.status).toBe(200);
		const note = await created.json();
		expect(note).toMatchObject({ title: "Plan" });
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({ notes: [note] });
	});
});
