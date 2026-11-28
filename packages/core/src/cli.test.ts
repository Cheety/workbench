import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
	OperationError,
} from "@workbench/sdk";
import { z } from "zod";
import { type Fetch, runCommandLine } from "./cli.ts";
import { Secret } from "./config.ts";
import type { PluginPackage } from "./kernel.ts";
import {
	API_INSTANCE_WORKSPACE,
	type ApiInstance,
	startApiInstance,
} from "./testing/api-instance.ts";
import { type ManualTimer, manualTimer } from "./testing/manual-timer.ts";
import { pluginPackageAt } from "./testing/operation-harness.ts";

const COMMAND = new URL("./cli.ts", import.meta.url).pathname;

const REFERENCE_DIRECTORY = join(
	new URL("../../", import.meta.url).pathname,
	"plugin-reference",
);

const UNKNOWN_WORKSPACE = "00000000-0000-4000-8000-00000000bbbb";

const REQUEST_DEADLINE_MS = 120_000;

const BODY_PART = '{"operations":';

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

const stampBook = defineOperation({
	name: "stampBook",
	kind: "mutation",
	target: "workspace",
	right: "ledger.book.stamp",
	input: z.object({ year: z.number().int() }),
	output: z.object({ year: z.number().int() }),
	execute: async ({ year }) => {
		throw new OperationError(
			"conflict",
			"book_already_stamped",
			`the book of ${year} is \u001b[31malready stamped\u001b[0m\u009b2J`,
		);
	},
});

const annotateBook = defineOperation({
	name: "annotateBook",
	kind: "mutation",
	target: "workspace",
	right: "ledger.book.annotate",
	input: z.object({
		remarks: z.record(
			z.string(),
			z.string().max(0, {
				message: "\u001b[8mis hidden\ncorrelation id: forged",
			}),
		),
	}),
	output: z.object({ annotated: z.boolean() }),
	execute: async () => ({ annotated: true }),
});

const readBook = defineOperation({
	name: "readBook",
	kind: "query",
	target: "workspace",
	right: "ledger.book.read",
	input: z.object({}),
	output: z.object({ title: z.string() }),
	execute: async () => ({ title: "\u009b31mred\u007f\u001b[0m" }),
});

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () => ({
		...definePlugin({
			manifest: { name: "ledger", capabilities: [DATABASE_CAPABILITY] },
		}),
		rights: [
			{ name: "ledger.book.close", defaultRoles: ["owner"] },
			{ name: "ledger.book.stamp", defaultRoles: ["owner"] },
			{ name: "ledger.book.annotate", defaultRoles: ["owner"] },
			{ name: "ledger.book.read", defaultRoles: ["owner"] },
		],
		operations: [closeBook, stampBook, annotateBook, readBook],
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
		env: { HOME: home, ...env },
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

async function runCliInProcess(
	args: readonly string[],
	instanceUrl: string,
	timer: ManualTimer,
	fetchOfRun: Fetch,
): Promise<Run> {
	let stdout = "";
	let stderr = "";
	const exitCode = await runCommandLine({
		args,
		loadConfig: () => ({
			instanceUrl: new URL(instanceUrl),
			token: new Secret("wbt_never-issued"),
		}),
		output: {
			writeOutput: (text) => {
				stdout += text;
			},
			writeError: (text) => {
				stderr += text;
			},
		},
		deadline: { ms: REQUEST_DEADLINE_MS, setTimer: timer.setTimer },
		fetch: fetchOfRun,
	});
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
	return {
		WORKBENCH_URL: api.url,
		WORKBENCH_TOKEN: await api.issueToken("owner"),
	};
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

const problem = z.object({
	code: z.string(),
	detail: z.string(),
	issues: z.array(
		z.object({
			path: z.array(z.union([z.string(), z.number()])),
			message: z.string(),
		}),
	),
});

const completedRequest = z.object({
	message: z.literal("request completed"),
	correlationId: z.string(),
});

function lastCorrelationIdIn(api: ApiInstance): string {
	const completed = api.logEntries.filter(
		(entry) => completedRequest.safeParse(entry).success,
	);
	return completedRequest.parse(completed.at(-1)).correlationId;
}

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

		const lines = run.stdout.split("\n");
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toBe("");
		expect(lines.at(-1)).toBe("");
		expect(lines.slice(0, -1).map((line) => line.split("\t").slice(1))).toEqual(
			[
				["core.createApiToken", "mutation"],
				["core.createWorkspace", "mutation"],
				["core.defineRole", "mutation"],
				["core.grantMembership", "mutation"],
				["core.listApiTokens", "query"],
				["core.listAuditEntries", "query"],
				["core.listInstanceAuditEntries", "query"],
				["core.listWorkspaces", "query"],
				["core.revokeApiToken", "mutation"],
				["core.revokeMembership", "mutation"],
				["reference.createNote", "mutation"],
				["reference.listNotes", "query"],
				["reference.renameNote", "mutation"],
			],
		);
		expect(lines).toContain(
			"reference create-note\treference.createNote\tmutation",
		);
		expect(lines).toContain(
			"core list-instance-audit-entries\tcore.listInstanceAuditEntries\tquery",
		);
	});
});

describe("an operation on the instance on the command line", () => {
	test("is called without a workspace and lists the workspaces of the actor", async () => {
		const api = await startReferenceInstance();

		const run = await runCli(
			[
				"core",
				"list-workspaces",
				"--input",
				JSON.stringify({ limit: 10, cursor: null }),
			],
			await accessTo(api),
		);

		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual({
			workspaces: [
				{ id: API_INSTANCE_WORKSPACE, name: "Accounts", role: "owner" },
			],
			nextCursor: null,
		});
	});

	test("answers workspace_required with exit code 1 for an operation on a workspace called without one", async () => {
		const api = await startReferenceInstance();

		const run = await runCli(
			[
				"reference",
				"create-note",
				"--input",
				JSON.stringify({ title: "Plan" }),
			],
			await accessTo(api),
		);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toStartWith("workspace_required: ");
	});
});

describe("an operation of the reference plugin on the command line and over HTTP", () => {
	test("answers the reference mutation with the same output", async () => {
		const overHttpApi = await startReferenceInstance();
		const overCliApi = await startReferenceInstance();
		const input = { title: "Plan" };

		const answeredOverHttp = await overHttp(
			overHttpApi,
			await overHttpApi.issueToken("owner"),
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
			input: { title: " " },
			code: "invalid_input",
			command: ["reference", "create-note"] as const,
			operation: "reference.createNote",
			workspace: API_INSTANCE_WORKSPACE,
		},
		{
			case: "a workspace that does not exist",
			input: { title: "Plan" },
			code: "workspace_not_found",
			command: ["reference", "create-note"] as const,
			operation: "reference.createNote",
			workspace: UNKNOWN_WORKSPACE,
		},
		{
			case: "a workspace that is not a UUID",
			input: { title: "Plan" },
			code: "invalid_workspace_id",
			command: ["reference", "create-note"] as const,
			operation: "reference.createNote",
			workspace: "accounts",
		},
		{
			case: "an operation the plugin does not have",
			input: { title: "Plan" },
			code: "unknown_operation",
			command: ["reference", "archive-note"] as const,
			operation: "reference.archiveNote",
			workspace: API_INSTANCE_WORKSPACE,
		},
	])(
		"fails for $case with exit code 1 and the stable code $code of the HTTP API",
		async ({ input, code, command, operation, workspace }) => {
			const api = await startReferenceInstance();
			const access = await accessTo(api);
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
			issues: [],
		});
		expect(run).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: [
				"ledger.book_already_closed: the book of 2025 is already closed",
				`correlation id: ${lastCorrelationIdIn(api)}`,
				"",
			].join("\n"),
		});
	});
});

describe("control characters in what the instance answers", () => {
	test("are written visibly escaped in the detail of a problem, so they cannot steer the terminal", async () => {
		const api = await startInstance([ledger]);

		const run = await runCli(
			callArgs(["ledger", "stamp-book"], API_INSTANCE_WORKSPACE, {
				year: 2025,
			}),
			await accessTo(api),
		);

		expect(run).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: [
				"ledger.book_already_stamped: the book of 2025 is \\x1b[31malready stamped\\x1b[0m\\x9b2J",
				`correlation id: ${lastCorrelationIdIn(api)}`,
				"",
			].join("\n"),
		});
	});

	test("are written visibly escaped in the path and message of an issue, so they cannot forge a line", async () => {
		const api = await startInstance([ledger]);

		const run = await runCli(
			callArgs(["ledger", "annotate-book"], API_INSTANCE_WORKSPACE, {
				remarks: { "\u001b[8m": "secret" },
			}),
			await accessTo(api),
		);

		expect(run).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: [
				"invalid_input: the input does not match the input schema of the operation",
				"  remarks.\\x1b[8m: \\x1b[8mis hidden\\x0acorrelation id: forged",
				`correlation id: ${lastCorrelationIdIn(api)}`,
				"",
			].join("\n"),
		});
	});

	test("are escaped in the JSON of an output, which still holds the value the instance answered", async () => {
		const api = await startInstance([ledger]);

		const run = await runCli(
			callArgs(["ledger", "read-book"], API_INSTANCE_WORKSPACE, {}),
			await accessTo(api),
		);

		expect(run).toEqual({
			exitCode: 0,
			stdout: '{"title":"\\u009b31mred\\u007f\\u001b[0m"}\n',
			stderr: "",
		});
		expect(JSON.parse(run.stdout)).toEqual({
			title: "\u009b31mred\u007f\u001b[0m",
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
	test("that does not match the input schema is reported with the code, detail and each issue of the HTTP API and exit code 1", async () => {
		const api = await startReferenceInstance();
		const access = await accessTo(api);
		const call = {
			operation: "reference.createNote",
			workspace: API_INSTANCE_WORKSPACE,
			input: { title: "" },
		};
		const failedOverHttp = problem.parse(
			await overHttp(api, access.WORKBENCH_TOKEN, call),
		);

		const run = await runCli(
			callArgs(["reference", "create-note"], call.workspace, call.input),
			access,
		);

		expect(failedOverHttp).toEqual({
			code: "invalid_input",
			detail: "the input does not match the input schema of the operation",
			issues: [{ path: ["title"], message: expect.any(String) }],
		});
		expect(run).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: [
				`${failedOverHttp.code}: ${failedOverHttp.detail}`,
				`  title: ${failedOverHttp.issues[0]?.message}`,
				`correlation id: ${lastCorrelationIdIn(api)}`,
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
		{ case: "a line break", key: "retry\n1" },
		{ case: "a comma", key: "retry,1" },
		{ case: "more than 255 characters", key: "r".repeat(256) },
	])(
		"with an idempotency key with $case is refused with exit code 2 before anything reaches the instance",
		async ({ key }) => {
			const api = await startReferenceInstance();

			const run = await runCli(
				[
					...callArgs(["reference", "create-note"], API_INSTANCE_WORKSPACE, {
						title: "Plan",
					}),
					"--idempotency-key",
					key,
				],
				await accessTo(api),
			);

			expect(run.exitCode).toBe(2);
			expect(run.stdout).toBe("");
			expect(run.stderr).toStartWith(
				"--idempotency-key must be 1 to 255 visible ASCII characters or spaces, without a comma\nusage: workbench",
			);
			expect(api.logEntries).not.toContainEqual(
				expect.objectContaining({ message: "request completed" }),
			);
		},
	);

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
			token: await api.issueToken("owner"),
		});

		const run = await runCliIn(home, ["operations"], {});

		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("reference create-note\t");
	});

	test("comes from the file that WORKBENCH_CONFIG names", async () => {
		const api = await startReferenceInstance();
		const elsewhere = await emptyHome();
		const file = join(elsewhere, "workbench.json");
		await writeFile(
			file,
			JSON.stringify({ token: await api.issueToken("owner") }),
		);

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
			WORKBENCH_TOKEN: await api.issueToken("owner"),
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
			const access = await accessTo(api);
			const token = await api.issueToken("owner");

			const run = await runCli(args(token), access);

			expect(run.exitCode).toBe(2);
			expect(run.stderr).toContain("usage: workbench operations\n");
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

	test("in a configuration file that cannot be read is reported by the file, with exit code 2", async () => {
		const home = await emptyHome();
		const directory = join(home, "workbench.json");
		await mkdir(directory);

		const run = await runCliIn(home, ["operations"], {
			WORKBENCH_CONFIG: directory,
		});

		expect(run).toEqual({
			exitCode: 2,
			stdout: "",
			stderr: [
				"invalid configuration:",
				`  ${directory} cannot be read`,
				"",
			].join("\n"),
		});
	});

	test("that the instance does not know is rejected as unauthenticated with the code and detail of the HTTP API and exit code 1", async () => {
		const api = await startReferenceInstance();
		const response = await fetch(`${api.url}/api/operations`, {
			headers: { Authorization: "Bearer wbt_never-issued" },
		});
		const failedOverHttp = problem.parse(await response.json());

		const run = await runCli(["operations"], {
			WORKBENCH_URL: api.url,
			WORKBENCH_TOKEN: "wbt_never-issued",
		});

		expect(failedOverHttp).toEqual({
			code: "unauthenticated",
			detail: "the request needs a valid API token as a bearer token",
			issues: [],
		});
		expect(run).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: [
				`${failedOverHttp.code}: ${failedOverHttp.detail}`,
				`correlation id: ${lastCorrelationIdIn(api)}`,
				"",
			].join("\n"),
		});
	});
});

describe("an answer that does not come from an instance", () => {
	test.each([
		{ status: 200, body: "<html>proxy</html>" },
		{ status: 502, body: "<html>bad gateway</html>" },
		{
			status: 200,
			body: JSON.stringify({
				operations: [{ name: "createNote", kind: "mutation" }],
			}),
		},
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

describe("a request that fetch refuses to send", () => {
	test("is thrown on as it came, writing nothing, instead of being reported as an instance that cannot be reached", async () => {
		const written: string[] = [];

		const running = runCommandLine({
			args: ["operations"],
			loadConfig: () => ({
				instanceUrl: new URL("http://127.0.0.1:1"),
				token: new Secret("wbt_refused\r\nX-Forged: yes"),
			}),
			output: {
				writeOutput: (text) => written.push(text),
				writeError: (text) => written.push(text),
			},
			deadline: { ms: REQUEST_DEADLINE_MS, setTimer: manualTimer().setTimer },
			fetch,
		});

		await expect(running).rejects.toBeInstanceOf(TypeError);
		expect(written).toEqual([]);
	});
});

describe("an instance that does not answer before the deadline of the command line", () => {
	test("is reported as unreachable with exit code 1 when it never answers the request", async () => {
		const received = Promise.withResolvers<void>();
		const silent = Bun.serve({
			port: 0,
			fetch: () => {
				received.resolve();
				return new Promise<Response>(() => {});
			},
		});
		const timer = manualTimer();
		try {
			const running = runCliInProcess(
				["operations"],
				`http://127.0.0.1:${silent.port}`,
				timer,
				fetch,
			);
			await received.promise;

			timer.expire();

			expect(await running).toEqual({
				exitCode: 1,
				stdout: "",
				stderr: `the instance at http://127.0.0.1:${silent.port} cannot be reached\n`,
			});
			expect(timer.delaysMs).toEqual([REQUEST_DEADLINE_MS]);
		} finally {
			await silent.stop(true);
		}
	});

	test("is reported as unreachable with exit code 1 when its body stops before it ends", async () => {
		const sockets: Socket[] = [];
		const stalling = createServer((socket) => {
			sockets.push(socket);
			socket.once("data", () => {
				socket.write(
					`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${2 * BODY_PART.length}\r\n\r\n${BODY_PART}`,
				);
			});
		});
		const listening = Promise.withResolvers<void>();
		stalling.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = stalling.address();
		if (address === null || typeof address === "string")
			throw new Error("the stalling server listens on no port");
		const headersReceived = Promise.withResolvers<void>();
		const fetchTellingHeaders: Fetch = async (url, init) => {
			const response = await fetch(url, init);
			headersReceived.resolve();
			return response;
		};
		const timer = manualTimer();
		try {
			const running = runCliInProcess(
				["operations"],
				`http://127.0.0.1:${address.port}`,
				timer,
				fetchTellingHeaders,
			);
			await headersReceived.promise;

			timer.expire();

			expect(await running).toEqual({
				exitCode: 1,
				stdout: "",
				stderr: `the instance at http://127.0.0.1:${address.port} cannot be reached\n`,
			});
		} finally {
			for (const socket of sockets) socket.destroy();
			stalling.close();
		}
	});
});
