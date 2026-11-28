import { parseArgs } from "node:util";
import { OPERATION_KINDS } from "@workbench/sdk";
import { z } from "zod";
import {
	type CliConfig,
	InvalidConfigError,
	loadCliConfigFromEnvironment,
} from "./config.ts";
import { IDEMPOTENCY_KEY_HEADER, OPERATIONS_PATH } from "./http-api.ts";
import { isPluginName } from "./plugin-name.ts";

const USAGE = [
	"usage: workbench operations",
	"       workbench <plugin> <operation> --workspace <uuid> --input <json> [--idempotency-key <key>]",
].join("\n");

const LIST_COMMAND = "operations";

const OPERATION_COMMAND = /^[a-z]+(?:-[a-z][a-z0-9]*)+$/;

const REQUEST_TIMEOUT_MS = 120_000;

const EXIT_CODES = { succeeded: 0, failed: 1, misused: 2 } as const;

type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

type Invocation =
	| { readonly command: "list" }
	| {
			readonly command: "call";
			readonly operation: string;
			readonly workspace: string;
			readonly input: string;
			readonly idempotencyKey: string | undefined;
	  };

type InvocationRead =
	| { readonly valid: true; readonly invocation: Invocation }
	| { readonly valid: false; readonly problem: string };

const operationList = z.object({
	operations: z.array(
		z.object({ name: z.string(), kind: z.enum(OPERATION_KINDS) }),
	),
});

const problemDetails = z.object({
	code: z.string(),
	detail: z.string(),
	correlationId: z.string(),
	issues: z.array(
		z.object({
			path: z.array(z.union([z.string(), z.number()])),
			message: z.string(),
		}),
	),
});

function readInvocation(args: readonly string[]): InvocationRead {
	let parsed: ReturnType<typeof parseOptions>;
	try {
		parsed = parseOptions(args);
	} catch (error) {
		if (error instanceof TypeError)
			return { valid: false, problem: "the options are not valid" };
		throw error;
	}
	const { values, positionals } = parsed;
	const [plugin, command, ...rest] = positionals;
	if (plugin === LIST_COMMAND && command === undefined) {
		if (Object.keys(values).length > 0)
			return { valid: false, problem: "operations takes no options" };
		return { valid: true, invocation: { command: "list" } };
	}
	if (
		plugin === undefined ||
		command === undefined ||
		rest.length > 0 ||
		!isPluginName(plugin) ||
		!OPERATION_COMMAND.test(command)
	)
		return { valid: false, problem: "the command is not valid" };
	const { workspace, input } = values;
	if (workspace === undefined)
		return { valid: false, problem: "--workspace is required" };
	if (input === undefined)
		return { valid: false, problem: "--input is required" };
	if (!isJson(input)) return { valid: false, problem: "--input is not JSON" };
	return {
		valid: true,
		invocation: {
			command: "call",
			operation: `${plugin}.${operationNameOf(command)}`,
			workspace,
			input,
			idempotencyKey: values["idempotency-key"],
		},
	};
}

function parseOptions(args: readonly string[]) {
	return parseArgs({
		args: [...args],
		options: {
			workspace: { type: "string" },
			input: { type: "string" },
			"idempotency-key": { type: "string" },
		},
		strict: true,
		allowPositionals: true,
	});
}

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		throw error;
	}
}

function operationNameOf(command: string): string {
	return command.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
}

function commandOf(operation: string): string {
	const [owner = "", name = ""] = operation.split(".");
	const kebab = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
	return `${owner} ${kebab}`;
}

async function invoke(
	invocation: Invocation,
	config: CliConfig,
): Promise<ExitCode> {
	const response = await send(invocation, config);
	if (response === undefined) {
		writeError(
			`the instance at ${config.instanceUrl.origin} cannot be reached`,
		);
		return EXIT_CODES.failed;
	}
	const body = await jsonOf(response);
	const answer = response.ok ? answerOf(invocation, body) : undefined;
	if (answer !== undefined) {
		process.stdout.write(answer);
		return EXIT_CODES.succeeded;
	}
	const problem = problemDetails.safeParse(body);
	writeError(
		problem.success
			? describeProblem(problem.data)
			: `the instance answered with HTTP ${response.status} and an unexpected body`,
	);
	return EXIT_CODES.failed;
}

async function send(
	invocation: Invocation,
	{ instanceUrl, token }: CliConfig,
): Promise<Response | undefined> {
	const headers = new Headers({ Authorization: `Bearer ${token.reveal()}` });
	const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	try {
		if (invocation.command === "list")
			return await fetch(new URL(OPERATIONS_PATH, instanceUrl), {
				headers,
				signal,
			});
		if (invocation.idempotencyKey !== undefined)
			headers.set(IDEMPOTENCY_KEY_HEADER, invocation.idempotencyKey);
		const path = `/api/workspaces/${encodeURIComponent(invocation.workspace)}/operations/${encodeURIComponent(invocation.operation)}`;
		return await fetch(new URL(path, instanceUrl), {
			method: "POST",
			headers,
			body: invocation.input,
			signal,
		});
	} catch (error) {
		if (error instanceof TypeError || isTimeout(error)) return undefined;
		throw error;
	}
}

function isTimeout(error: unknown): boolean {
	return error instanceof DOMException && error.name === "TimeoutError";
}

async function jsonOf(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function answerOf(invocation: Invocation, body: unknown): string | undefined {
	if (body === undefined) return undefined;
	if (invocation.command === "call") return `${JSON.stringify(body)}\n`;
	const listed = operationList.safeParse(body);
	if (!listed.success) return undefined;
	return listed.data.operations
		.map(({ name, kind }) => `${commandOf(name)}\t${name}\t${kind}\n`)
		.join("");
}

function describeProblem(problem: z.infer<typeof problemDetails>): string {
	return [
		`${problem.code}: ${problem.detail}`,
		...problem.issues.map(
			(issue) =>
				`  ${issue.path.length === 0 ? "(input)" : issue.path.join(".")}: ${issue.message}`,
		),
		`correlation id: ${problem.correlationId}`,
	].join("\n");
}

function writeError(text: string): void {
	process.stderr.write(`${text}\n`);
}

const read = readInvocation(Bun.argv.slice(2));
if (!read.valid) {
	writeError(`${read.problem}\n${USAGE}`);
	process.exit(EXIT_CODES.misused);
}

let config: CliConfig;
try {
	config = loadCliConfigFromEnvironment();
} catch (error) {
	if (!(error instanceof InvalidConfigError)) throw error;
	writeError(
		[
			"invalid configuration:",
			...error.issues.map((issue) => `  ${issue.variable} ${issue.problem}`),
		].join("\n"),
	);
	process.exit(EXIT_CODES.misused);
}

process.exit(await invoke(read.invocation, config));
