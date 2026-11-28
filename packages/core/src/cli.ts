import { parseArgs } from "node:util";
import { OPERATION_KINDS } from "@workbench/sdk";
import { z } from "zod";
import {
	type CliConfig,
	InvalidCliConfigError,
	loadCliConfigFromEnvironment,
} from "./config.ts";
import { UNKNOWN_FAILURE_REASON } from "./failure-reason.ts";
import { type HookTimeout, setSystemTimer } from "./hook-timeout.ts";
import {
	IDEMPOTENCY_KEY_HEADER,
	INSTANCE_OPERATION_PATH_TEMPLATE,
	OPERATION_LIST_PATH,
	OPERATION_PATH_TEMPLATE,
} from "./http-api.ts";
import {
	IDEMPOTENCY_KEY_RULE,
	type IdempotencyKey,
	parseIdempotencyKey,
} from "./idempotency-keys.ts";
import { type JsonText, parseJsonText } from "./json-text.ts";
import {
	findQualifiedOperationName,
	type QualifiedOperationName,
	qualifiedOperationName,
} from "./operation-registry.ts";
import { isPluginName } from "./plugin-name.ts";
import { systemFailureReason } from "./system-error.ts";

const USAGE = [
	"usage: workbench operations",
	"       workbench <plugin> <operation> [--workspace <uuid>] --input <json> [--idempotency-key <key>]",
].join("\n");

const LISTING_CLI_COMMAND = "operations";

const KEBAB_CASE_OPERATION = /^[a-z]+(?:-[a-z][a-z0-9]*)+$/;

const REQUEST_TIMEOUT_MS = 120_000;

const PARSE_ARGS_ERROR_CODE_PREFIX = "ERR_PARSE_ARGS_";

const LAST_C0_CONTROL = 0x1f;

const FIRST_DEL_OR_C1_CONTROL = 0x7f;

const LAST_C1_CONTROL = 0x9f;

const EXIT_CODES = { succeeded: 0, failed: 1, misused: 2 } as const;

type Invocation =
	| { readonly action: "list" }
	| {
			readonly action: "call";
			readonly operation: string;
			readonly workspace: string | null;
			readonly input: string;
			readonly idempotencyKey: IdempotencyKey | undefined;
	  };

type ParsedInvocation =
	| { readonly ok: true; readonly invocation: Invocation }
	| { readonly ok: false; readonly problem: string };

type Sent =
	| {
			readonly reached: true;
			readonly status: number;
			readonly ok: boolean;
			readonly body: JsonText;
	  }
	| { readonly reached: false };

type Exchange = {
	readonly path: string;
	readonly init: RequestInit;
	findAnswer(body: unknown): string | undefined;
};

const operationList = z.object({
	operations: z.array(
		z.object({
			name: z.string().transform((name, context) => {
				const qualified = findQualifiedOperationName(name);
				if (qualified !== undefined) return qualified;
				context.addIssue({
					code: "custom",
					message: "is not the name of an operation",
				});
				return z.NEVER;
			}),
			kind: z.enum(OPERATION_KINDS),
		}),
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

function readInvocation(args: readonly string[]): ParsedInvocation {
	let parsed: ReturnType<typeof parseOptions>;
	try {
		parsed = parseOptions(args);
	} catch (error) {
		if (isParseArgsError(error))
			return { ok: false, problem: "the options are not valid" };
		throw error;
	}
	const { values, positionals } = parsed;
	const [plugin, operation, ...rest] = positionals;
	if (plugin === LISTING_CLI_COMMAND && operation === undefined) {
		if (Object.keys(values).length > 0)
			return { ok: false, problem: "operations takes no options" };
		return { ok: true, invocation: { action: "list" } };
	}
	if (
		plugin === undefined ||
		operation === undefined ||
		rest.length > 0 ||
		!isPluginName(plugin) ||
		!KEBAB_CASE_OPERATION.test(operation)
	)
		return { ok: false, problem: "the command is not valid" };
	const { workspace, input } = values;
	if (input === undefined) return { ok: false, problem: "--input is required" };
	if (!parseJsonText(input).parsed)
		return { ok: false, problem: "--input is not JSON" };
	const idempotencyKey = values["idempotency-key"];
	const parsedKey =
		idempotencyKey === undefined
			? undefined
			: parseIdempotencyKey(idempotencyKey);
	if (parsedKey !== undefined && !parsedKey.valid)
		return {
			ok: false,
			problem: `--idempotency-key must be ${IDEMPOTENCY_KEY_RULE}`,
		};
	return {
		ok: true,
		invocation: {
			action: "call",
			operation: qualifiedOperationName({
				plugin,
				name: camelCaseOf(operation),
			}),
			workspace: workspace ?? null,
			input,
			idempotencyKey: parsedKey?.key,
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

function isParseArgsError(error: unknown): boolean {
	return (
		error instanceof TypeError &&
		"code" in error &&
		typeof error.code === "string" &&
		error.code.startsWith(PARSE_ARGS_ERROR_CODE_PREFIX)
	);
}

function camelCaseOf(kebabCase: string): string {
	return kebabCase.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
}

function cliCommandOf({ plugin, name }: QualifiedOperationName): string {
	const kebabCase = name.replace(
		/[A-Z]/g,
		(letter) => `-${letter.toLowerCase()}`,
	);
	return `${plugin} ${kebabCase}`;
}

function exchangeFor(invocation: Invocation, config: CliConfig): Exchange {
	const authorization = { Authorization: `Bearer ${config.token.reveal()}` };
	switch (invocation.action) {
		case "list":
			return {
				path: OPERATION_LIST_PATH,
				init: { headers: authorization },
				findAnswer: findListing,
			};
		case "call":
			return {
				path: operationPathOf(invocation),
				init: {
					method: "POST",
					headers: {
						...authorization,
						...(invocation.idempotencyKey === undefined
							? {}
							: { [IDEMPOTENCY_KEY_HEADER]: invocation.idempotencyKey }),
					},
					body: invocation.input,
				},
				findAnswer: (output) => `${jsonWithEscapedControls(output)}\n`,
			};
	}
}

function operationPathOf({
	workspace,
	operation,
}: {
	readonly workspace: string | null;
	readonly operation: string;
}): string {
	const template =
		workspace === null
			? INSTANCE_OPERATION_PATH_TEMPLATE
			: OPERATION_PATH_TEMPLATE.replace("{workspace}", () =>
					encodeURIComponent(workspace),
				);
	return template.replace("{operation}", () => encodeURIComponent(operation));
}

function findListing(body: unknown): string | undefined {
	const listed = operationList.safeParse(body);
	if (!listed.success) return undefined;
	return listed.data.operations
		.map(
			({ name, kind }) =>
				`${cliCommandOf(name)}\t${qualifiedOperationName(name)}\t${kind}\n`,
		)
		.join("");
}

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type CliOutput = {
	writeOutput(text: string): void;
	writeError(text: string): void;
};

export type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

export type CommandLineRun = {
	readonly args: readonly string[];
	readonly loadConfig: () => CliConfig;
	readonly output: CliOutput;
	readonly deadline: HookTimeout;
	readonly fetch: Fetch;
};

export async function runCommandLine({
	args,
	loadConfig,
	output,
	deadline,
	fetch,
}: CommandLineRun): Promise<ExitCode> {
	const parsed = readInvocation(args);
	if (!parsed.ok) {
		output.writeError(`${parsed.problem}\n${USAGE}\n`);
		return EXIT_CODES.misused;
	}
	let config: CliConfig;
	try {
		config = loadConfig();
	} catch (error) {
		if (!(error instanceof InvalidCliConfigError)) throw error;
		output.writeError(
			`${[
				"invalid configuration:",
				...error.issues.map((issue) => `  ${issue.subject} ${issue.problem}`),
			].join("\n")}\n`,
		);
		return EXIT_CODES.misused;
	}
	const expiry = new AbortController();
	const cancel = deadline.setTimer(() => expiry.abort(), deadline.ms);
	try {
		return await invoke(parsed.invocation, config, output, {
			fetch,
			expired: expiry.signal,
		});
	} finally {
		cancel();
	}
}

type Transport = {
	readonly fetch: Fetch;
	readonly expired: AbortSignal;
};

async function invoke(
	invocation: Invocation,
	config: CliConfig,
	output: CliOutput,
	transport: Transport,
): Promise<ExitCode> {
	const exchange = exchangeFor(invocation, config);
	const sent = await send(exchange, config.instanceUrl, transport);
	if (!sent.reached) {
		output.writeError(
			`the instance at ${config.instanceUrl.origin} cannot be reached\n`,
		);
		return EXIT_CODES.failed;
	}
	const { status, ok, body } = sent;
	const answer =
		ok && body.parsed ? exchange.findAnswer(body.value) : undefined;
	if (answer !== undefined) {
		output.writeOutput(answer);
		return EXIT_CODES.succeeded;
	}
	const problem = problemDetails.safeParse(
		body.parsed ? body.value : undefined,
	);
	output.writeError(
		`${
			problem.success
				? describeProblem(problem.data)
				: `the instance answered with HTTP ${status} and an unexpected body`
		}\n`,
	);
	return EXIT_CODES.failed;
}

async function send(
	{ path, init }: Exchange,
	instanceUrl: URL,
	{ fetch, expired }: Transport,
): Promise<Sent> {
	try {
		const response = await fetch(new URL(path, instanceUrl), {
			...init,
			signal: expired,
		});
		const body = parseJsonText(await response.text());
		return { reached: true, status: response.status, ok: response.ok, body };
	} catch (error) {
		if (expired.aborted || isNetworkFailure(error)) return { reached: false };
		throw error;
	}
}

function isNetworkFailure(error: unknown): boolean {
	return (
		error instanceof TypeError &&
		systemFailureReason(error) !== UNKNOWN_FAILURE_REASON
	);
}

function describeProblem(problem: z.infer<typeof problemDetails>): string {
	return [
		`${visible(problem.code)}: ${visible(problem.detail)}`,
		...problem.issues.map(
			(issue) =>
				`  ${issue.path.length === 0 ? "(input)" : visible(issue.path.join("."))}: ${visible(issue.message)}`,
		),
		`correlation id: ${visible(problem.correlationId)}`,
	].join("\n");
}

function visible(text: string): string {
	return replaceControls(
		text,
		(code) => `\\x${code.toString(16).padStart(2, "0")}`,
	);
}

function jsonWithEscapedControls(value: unknown): string {
	return replaceControls(
		JSON.stringify(value),
		(code) => `\\u${code.toString(16).padStart(4, "0")}`,
	);
}

function replaceControls(
	text: string,
	escaped: (code: number) => string,
): string {
	return Array.from(text, (character) => {
		const code = character.charCodeAt(0);
		return isControl(code) ? escaped(code) : character;
	}).join("");
}

function isControl(code: number): boolean {
	return (
		code <= LAST_C0_CONTROL ||
		(code >= FIRST_DEL_OR_C1_CONTROL && code <= LAST_C1_CONTROL)
	);
}

if (import.meta.main) {
	process.exit(
		await runCommandLine({
			args: Bun.argv.slice(2),
			loadConfig: loadCliConfigFromEnvironment,
			output: {
				writeOutput: (text) => process.stdout.write(text),
				writeError: (text) => process.stderr.write(text),
			},
			deadline: { ms: REQUEST_TIMEOUT_MS, setTimer: setSystemTimer },
			fetch,
		}),
	);
}
