import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
	OperationError,
} from "@workbench/sdk";
import { z } from "zod";
import type { PluginPackage } from "./kernel.ts";
import {
	API_INSTANCE_WORKSPACE,
	type ApiInstance,
	startApiInstance,
} from "./testing/api-instance.ts";
import { pluginPackageAt } from "./testing/operation-harness.ts";

const COMMAND = new URL("./cli.ts", import.meta.url).pathname;

const REFERENCE_DIRECTORY = join(
	new URL("../../", import.meta.url).pathname,
	"plugin-reference",
);

const UNKNOWN_WORKSPACE = "00000000-0000-4000-8000-00000000bbbb";

const closeBook = defineOperation({
	name: "closeBook",
	kind: "mutation",
	target: "workspace",
	right: "ledger.book.close",
	input: z.object({ year: z.number().int() }),
	output: z.object({ year: z.number().int() }),
	execute: async ({ year }) => {
		throw new OperationError(
			"conflict",
			"book_already_closed",
			`the book of ${year} is already closed`,
		);
	},
});

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () => ({
		...definePlugin({
			manifest: { name: "ledger", capabilities: [DATABASE_CAPABILITY] },
		}),
		operations: [closeBook],
	}),
	loadMigrations: async () => [],
};

const instances: ApiInstance[] = [];

const homes: string[] = [];

afterEach(async () => {
	for (const instance of instances.splice(0)) await instance.stop();
	for (const home of homes.splice(0)) await rm(home, { recursive: true });
});

async function startInstance(
	plugins: readonly PluginPackage[],
): Promise<ApiInstance> {
	const instance = await startApiInstance(plugins);
	instances.push(instance);
	return instance;
}

async function startReferenceInstance(): Promise<ApiInstance> {
	return startInstance([await pluginPackageAt(REFERENCE_DIRECTORY)]);
}

async function emptyHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "workbench-cli-"));
	homes.push(home);
	return home;
}

async function homeWithConfigFile(content: unknown): Promise<string> {
	const home = await emptyHome();
	const directory = join(home, ".config", "workbench");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "cli.json"), JSON.stringify(content));
	return home;
}

type Run = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

async function runCliIn(
	home: string,
	args: readonly string[],
	env: Readonly<Record<string, string>>,
): Promise<Run> {
	const command = Bun.spawn([process.execPath, COMMAND, ...args], {
		env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		command.exited,
		new Response(command.stdout).text(),
		new Response(command.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function runCli(
	args: readonly string[],
	env: Readonly<Record<string, string>>,
): Promise<Run> {
	return runCliIn(await emptyHome(), args, env);
}

type Access = {
	readonly WORKBENCH_URL: string;
	readonly WORKBENCH_TOKEN: string;
};

async function accessTo(api: ApiInstance): Promise<Access> {
	return { WORKBENCH_URL: api.url, WORKBENCH_TOKEN: await api.issueToken() };
}

function callArgs(
	command: readonly [string, string],
	workspace: string,
	input: unknown,
): string[] {
	return [
		...command,
		"--workspace",
		workspace,
		"--input",
		JSON.stringify(input),
	];
}

const answer = z.record(z.string(), z.unknown());

type Answer = z.infer<typeof answer>;

const problem = z.object({ code: z.string(), detail: z.string() });

async function overHttp(
	api: ApiInstance,
	token: string,
	call: {
		readonly operation: string;
		readonly workspace: string;
		readonly input: unknown;
	},
): Promise<Answer> {
	const response = await api.post(
		`/api/workspaces/${call.workspace}/operations/${call.operation}`,
		JSON.stringify(call.input),
		{ Authorization: `Bearer ${token}` },
	);
	return answer.parse(await response.json());
}

describe("the command line listing the operations", () => {
	test("names the command, the operation and the kind of every operation of the instance", async () => {
		const api = await startReferenceInstance();

		const run = await runCli(["operations"], await accessTo(api));

		expect(run).toEqual({
			exitCode: 0,
			stdout: [
				"core list-audit-entries\tcore.listAuditEntries\tquery",
				"reference create-note\treference.createNote\tmutation",
				"reference list-notes\treference.listNotes\tquery",
				"",
			].join("\n"),
			stderr: "",
		});
	});
});

describe("an operation of the reference plugin on the command line and over HTTP", () => {
	test("answers the reference mutation with the same output", async () => {
		const overHttpApi = await startReferenceInstance();
		const overCliApi = await startReferenceInstance();
		const input = { title: "Plan" };

		const answeredOverHttp = await overHttp(
			overHttpApi,
			await overHttpApi.issueToken(),
			{
				operation: "reference.createNote",
				workspace: API_INSTANCE_WORKSPACE,
				input,
			},
		);
		const run = await runCli(
			callArgs(["reference", "create-note"], API_INSTANCE_WORKSPACE, input),
			await accessTo(overCliApi),
		);

		expect(answeredOverHttp).toEqual({
			id: expect.any(String),
			title: "Plan",
			createdAt: "2026-11-26T08:00:00.000Z",
		});
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toBe("");
		expect(answer.parse(JSON.parse(run.stdout))).toEqual(answeredOverHttp);
	});

	test("reaches the same operation, so a note created on the command line is listed over HTTP", async () => {
		const api = await startReferenceInstance();
		const access = await accessTo(api);
		const created = await runCli(
			callArgs(["reference", "create-note"], API_INSTANCE_WORKSPACE, {
				title: "Plan",
			}),
			access,
		);

		const listed = await overHttp(api, access.WORKBENCH_TOKEN, {
			operation: "reference.listNotes",
			workspace: API_INSTANCE_WORKSPACE,
			input: { limit: 10 },
		});

		expect(listed).toEqual({ notes: [JSON.parse(created.stdout)] });
	});

	test.each([
		{
			case: "an empty title",
			code: "invalid_input",
			command: ["reference", "create-note"] as const,
			operation: "reference.createNote",
			workspace: API_INSTANCE_WORKSPACE,
		},
		{
			case: "a workspace that does not exist",
			code: "workspace_not_found",
			command: ["reference", "create-note"] as const,
			operation: "reference.createNote",
			workspace: UNKNOWN_WORKSPACE,
		},
		{
			case: "a workspace that is not a UUID",
			code: "invalid_workspace_id",
			command: ["reference", "create-note"] as const,
			operation: "reference.createNote",
			workspace: "accounts",
		},
		{
			case: "an operation the plugin does not have",
			code: "unknown_operation",
			command: ["reference", "rename-note"] as const,
			operation: "reference.renameNote",
			workspace: API_INSTANCE_WORKSPACE,
		},
	])(
		"fails for $case with exit code 1 and the stable code $code of the HTTP API",
		async ({ case: failure, code, command, operation, workspace }) => {
			const api = await startReferenceInstance();
			const access = await accessTo(api);
			const input = { title: failure === "an empty title" ? " " : "Plan" };
			const failedOverHttp = problem.parse(
				await overHttp(api, access.WORKBENCH_TOKEN, {
					operation,
					workspace,
					input,
				}),
			);

			const run = await runCli(callArgs(command, workspace, input), access);

			expect(failedOverHttp.code).toBe(code);
			expect(run.exitCode).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr.split("\n")[0]).toBe(
				`${failedOverHttp.code}: ${failedOverHttp.detail}`,
			);
		},
	);
});

describe("a domain error of a plugin on the command line and over HTTP", () => {
	test("comes with the same stable code and detail of the plugin", async () => {
		const api = await startInstance([ledger]);
		const access = await accessTo(api);
		const call = {
			operation: "ledger.closeBook",
			workspace: API_INSTANCE_WORKSPACE,
			input: { year: 2025 },
		};
		const failedOverHttp = problem.parse(
			await overHttp(api, access.WORKBENCH_TOKEN, call),
		);

		const run = await runCli(
			callArgs(["ledger", "close-book"], call.workspace, call.input),
			access,
		);

		expect(failedOverHttp).toEqual({
			code: "ledger.book_already_closed",
			detail: "the book of 2025 is already closed",
		});
		expect(run).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: [
				"ledger.book_already_closed: the book of 2025 is already closed",
				"correlation id: request-2",
				"",
			].join("\n"),
		});
	});
});

describe("an idempotency key on the command line and over HTTP", () => {
	test("is the same key, so a mutation repeated on the command line answers what it answered over HTTP", async () => {
		const api = await startReferenceInstance();
		const access = await accessTo(api);
		const response = await api.post(
			`/api/workspaces/${API_INSTANCE_WORKSPACE}/operations/reference.createNote`,
			JSON.stringify({ title: "Plan" }),
			{
				Authorization: `Bearer ${access.WORKBENCH_TOKEN}`,
				"Idempotency-Key": "retry-1",
			},
		);
		const createdOverHttp = answer.parse(await response.json());

		const run = await runCli(
			[
				...callArgs(["reference", "create-note"], API_INSTANCE_WORKSPACE, {
					title: "Plan",
				}),
				"--idempotency-key",
				"retry-1",
			],
			access,
		);

		const listed = await overHttp(api, access.WORKBENCH_TOKEN, {
			operation: "reference.listNotes",
			workspace: API_INSTANCE_WORKSPACE,
			input: { limit: 10 },
		});
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual(createdOverHttp);
		expect(listed).toEqual({ notes: [createdOverHttp] });
	});
});

describe("an input on the command line", () => {
	test("that does not match the input schema is reported with each issue and exit code 1", async () => {
		const api = await startReferenceInstance();

		const run = await runCli(
			callArgs(["reference", "create-note"], API_INSTANCE_WORKSPACE, {
				title: "",
			}),
			await accessTo(api),
		);

		expect(run).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: [
				"invalid_input: the input does not match the input schema of the operation",
				"  title: Too small: expected string to have >=1 characters",
				"correlation id: request-1",
				"",
			].join("\n"),
		});
	});

	test("that is not JSON is refused with exit code 2 before anything reaches the instance", async () => {
		const api = await startReferenceInstance();

		const run = await runCli(
			[
				"reference",
				"create-note",
				"--workspace",
				API_INSTANCE_WORKSPACE,
				"--input",
				"{title:",
			],
			await accessTo(api),
		);

		expect(run.exitCode).toBe(2);
		expect(run.stdout).toBe("");
		expect(run.stderr).toStartWith("--input is not JSON\nusage: workbench");
		expect(api.logEntries).not.toContainEqual(
			expect.objectContaining({ message: "request completed" }),
		);
	});

	test.each([
		{ case: "no command", args: [] },
		{ case: "only a plugin", args: ["reference"] },
		{
			case: "an operation in camelCase",
			args: [
				"reference",
				"createNote",
				"--workspace",
				API_INSTANCE_WORKSPACE,
				"--input",
				"{}",
			],
		},
		{
			case: "the name of the operation as one word",
			args: [
				"reference.createNote",
				"--workspace",
				API_INSTANCE_WORKSPACE,
				"--input",
				"{}",
			],
		},
		{
			case: "no workspace",
			args: ["reference", "create-note", "--input", "{}"],
		},
		{
			case: "no input",
			args: ["reference", "create-note", "--workspace", API_INSTANCE_WORKSPACE],
		},
		{ case: "an unknown option", args: ["operations", "--verbose"] },
	])(
		"with $case is refused with exit code 2 and the usage",
		async ({ args }) => {
			const api = await startReferenceInstance();

			const run = await runCli(args, await accessTo(api));

			expect(run.exitCode).toBe(2);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("usage: workbench operations\n");
			expect(api.logEntries).not.toContainEqual(
				expect.objectContaining({ message: "request completed" }),
			);
		},
	);
});

describe("the API token of the command line", () => {
	test("comes from the configuration file when the environment names none", async () => {
		const api = await startReferenceInstance();
		const home = await homeWithConfigFile({
			url: api.url,
			token: await api.issueToken(),
		});

		const run = await runCliIn(home, ["operations"], {});

		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("reference create-note\t");
	});

	test("comes from the file that WORKBENCH_CONFIG names", async () => {
		const api = await startReferenceInstance();
		const elsewhere = await emptyHome();
		const file = join(elsewhere, "workbench.json");
		await writeFile(file, JSON.stringify({ token: await api.issueToken() }));

		const run = await runCli(["operations"], {
			WORKBENCH_URL: api.url,
			WORKBENCH_CONFIG: file,
		});

		expect(run.exitCode).toBe(0);
	});

	test("in the environment takes precedence over the configuration file", async () => {
		const api = await startReferenceInstance();
		const home = await homeWithConfigFile({
			url: api.url,
			token: "wbt_never-issued",
		});

		const run = await runCliIn(home, ["operations"], {
			WORKBENCH_TOKEN: await api.issueToken(),
		});

		expect(run.exitCode).toBe(0);
	});

	test("never appears in the log of the instance or in the output of the command line", async () => {
		const api = await startReferenceInstance();
		const access = await accessTo(api);

		const runs = [
			await runCli(["operations"], access),
			await runCli(
				callArgs(["reference", "create-note"], API_INSTANCE_WORKSPACE, {
					title: "",
				}),
				access,
			),
		];

		expect(JSON.stringify(api.logEntries)).not.toContain(
			access.WORKBENCH_TOKEN,
		);
		for (const run of runs) {
			expect(run.stdout).not.toContain(access.WORKBENCH_TOKEN);
			expect(run.stderr).not.toContain(access.WORKBENCH_TOKEN);
		}
	});

	test.each([
		{
			case: "a separate value",
			args: (token: string) => ["operations", "--token", token],
		},
		{
			case: "an inline value",
			args: (token: string) => [`--token=${token}`, "operations"],
		},
	])(
		"is refused as an option with $case, with exit code 2 and without repeating it",
		async ({ args }) => {
			const api = await startReferenceInstance();
			const token = await api.issueToken();

			const run = await runCli(args(token), { WORKBENCH_URL: api.url });

			expect(run.exitCode).toBe(2);
			expect(run.stderr).not.toContain(token);
			expect(api.logEntries).not.toContainEqual(
				expect.objectContaining({ message: "request completed" }),
			);
		},
	);

	test("that is missing is reported by the variable and the file that name it, with exit code 2", async () => {
		const home = await emptyHome();

		const run = await runCliIn(home, ["operations"], {
			WORKBENCH_URL: "http://127.0.0.1:1",
		});

		expect(run).toEqual({
			exitCode: 2,
			stdout: "",
			stderr: [
				"invalid configuration:",
				`  WORKBENCH_TOKEN, or token in ${join(home, ".config", "workbench", "cli.json")} is required`,
				"",
			].join("\n"),
		});
	});

	test("that the instance does not know is rejected as unauthenticated with exit code 1", async () => {
		const api = await startReferenceInstance();

		const run = await runCli(["operations"], {
			WORKBENCH_URL: api.url,
			WORKBENCH_TOKEN: "wbt_never-issued",
		});

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toStartWith(
			"unauthenticated: the request needs a valid API token as a bearer token\n",
		);
	});
});

describe("an answer that does not come from an instance", () => {
	test.each([
		{ status: 200, body: "<html>proxy</html>" },
		{ status: 502, body: "<html>bad gateway</html>" },
	])(
		"is reported by its status $status with exit code 1",
		async ({ status, body }) => {
			const proxy = Bun.serve({
				port: 0,
				fetch: () => new Response(body, { status }),
			});
			try {
				const run = await runCli(["operations"], {
					WORKBENCH_URL: `http://127.0.0.1:${proxy.port}`,
					WORKBENCH_TOKEN: "wbt_never-issued",
				});

				expect(run).toEqual({
					exitCode: 1,
					stdout: "",
					stderr: `the instance answered with HTTP ${status} and an unexpected body\n`,
				});
			} finally {
				await proxy.stop(true);
			}
		},
	);
});

describe("an instance the command line cannot reach", () => {
	test("is reported with exit code 1", async () => {
		const run = await runCli(["operations"], {
			WORKBENCH_URL: "http://127.0.0.1:1",
			WORKBENCH_TOKEN: "wbt_never-issued",
		});

		expect(run).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: "the instance at http://127.0.0.1:1 cannot be reached\n",
		});
	});
});
