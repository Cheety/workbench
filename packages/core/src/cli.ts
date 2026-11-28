import { parseArgs } from "node:util";
import { OPERATION_KINDS } from "@workbench/sdk";
import { z } from "zod";
import {
	type CliConfig,
	InvalidCliConfigError,
	loadCliConfigFromEnvironment,
} from "./config.ts";
import {
	IDEMPOTENCY_KEY_HEADER,
	OPERATION_LIST_PATH,
	OPERATION_PATH_TEMPLATE,
} from "./http-api.ts";
import { parseJsonText } from "./json-text.ts";
import { OPERATION_NAME } from "./operation-registry.ts";
import { isPluginName } from "./plugin-name.ts";

const USAGE = [
	"usage: workbench operations",
	"       workbench <plugin> <operation> --workspace <uuid> --input <json> [--idempotency-key <key>]",
].join("\n");

const LISTING_CLI_COMMAND = "operations";

const KEBAB_CASE_OPERATION = /^[a-z]+(?:-[a-z][a-z0-9]*)+$/;

const OPERATION_NAME_SEPARATOR = ".";

const REQUEST_TIMEOUT_MS = 120_000;

const EXIT_CODES = { succeeded: 0, failed: 1, misused: 2 } as const;

type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

type Invocation =
	| { readonly action: "list" }
	| {
			readonly action: "call";
			readonly operation: string;
			readonly workspace: string;
			readonly input: string;
			readonly idempotencyKey: string | undefined;
	  };

type InvocationRead =
	| { readonly valid: true; readonly invocation: Invocation }
	| { readonly valid: false; readonly problem: string };

type Exchange = {
	readonly path: string;
	readonly init: RequestInit;
	answerOf(body: unknown): string | undefined;
};

const operationList = z.object({
	operations: z.array(
		z.object({
			name: z.string(),
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

class UnexpectedOperationNameError extends Error {
	constructor(name: string) {
		super(`${JSON.stringify(name)} is not the name of an operation`);
		this.name = "UnexpectedOperationNameError";
	}
}

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
	const [plugin, operation, ...rest] = positionals;
	if (plugin === LISTING_CLI_COMMAND && operation === undefined) {
		if (Object.keys(values).length > 0)
			return { valid: false, problem: "operations takes no options" };
		return { valid: true, invocation: { action: "list" } };
	}
	if (
		plugin === undefined ||
		operation === undefined ||
		rest.length > 0 ||
		!isPluginName(plugin) ||
		!KEBAB_CASE_OPERATION.test(operation)
	)
		return { valid: false, problem: "the command is not valid" };
	const { workspace, input } = values;
	if (workspace === undefined)
		return { valid: false, problem: "--workspace is required" };
	if (input === undefined)
		return { valid: false, problem: "--input is required" };
	if (!parseJsonText(input).parsed)
		return { valid: false, problem: "--input is not JSON" };
	return {
		valid: true,
		invocation: {
			action: "call",
			operation: `${plugin}${OPERATION_NAME_SEPARATOR}${camelCaseOf(operation)}`,
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

function camelCaseOf(kebabCase: string): string {
	return kebabCase.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
}

type QualifiedOperationName = {
	readonly plugin: string;
	readonly name: string;
};

function findQualifiedOperationName(
	operation: string,
): QualifiedOperationName | undefined {
	const separator = operation.indexOf(OPERATION_NAME_SEPARATOR);
	const plugin = operation.slice(0, separator);
	const name = operation.slice(separator + OPERATION_NAME_SEPARATOR.length);
	if (separator < 0 || !isPluginName(plugin) || !OPERATION_NAME.test(name))
		return undefined;
	return { plugin, name };
}

function cliCommandOf(operation: string): string {
	const qualified = findQualifiedOperationName(operation);
	if (qualified === undefined)
		throw new UnexpectedOperationNameError(operation);
	const { plugin, name } = qualified;
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
				answerOf: listingOf,
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
				answerOf: (output) => `${JSON.stringify(output)}\n`,
			};
	}
}

function operationPathOf({
	workspace,
	operation,
}: {
	readonly workspace: string;
	readonly operation: string;
}): string {
	return OPERATION_PATH_TEMPLATE.replace("{workspace}", () =>
		encodeURIComponent(workspace),
	).replace("{operation}", () => encodeURIComponent(operation));
}

function listingOf(body: unknown): string | undefined {
	const listed = operationList.safeParse(body);
	if (!listed.success) return undefined;
	return listed.data.operations
		.map(({ name, kind }) => `${cliCommandOf(name)}\t${name}\t${kind}\n`)
		.join("");
}

async function invoke(
	invocation: Invocation,
	config: CliConfig,
): Promise<ExitCode> {
	const exchange = exchangeFor(invocation, config);
	const response = await send(exchange, config.instanceUrl);
	if (response === undefined) {
		writeError(
			`the instance at ${config.instanceUrl.origin} cannot be reached`,
		);
		return EXIT_CODES.failed;
	}
	const body = parseJsonText(await response.text());
	const answer =
		response.ok && body.parsed ? exchange.answerOf(body.value) : undefined;
	if (answer !== undefined) {
		process.stdout.write(answer);
		return EXIT_CODES.succeeded;
	}
	const problem = problemDetails.safeParse(
		body.parsed ? body.value : undefined,
	);
	writeError(
		problem.success
			? describeProblem(problem.data)
			: `the instance answered with HTTP ${response.status} and an unexpected body`,
	);
	return EXIT_CODES.failed;
}

async function send(
	{ path, init }: Exchange,
	instanceUrl: URL,
): Promise<Response | undefined> {
	try {
		return await fetch(new URL(path, instanceUrl), {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof TypeError || isTimeout(error)) return undefined;
		throw error;
	}
}

function isTimeout(error: unknown): boolean {
	return error instanceof DOMException && error.name === "TimeoutError";
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
	if (!(error instanceof InvalidCliConfigError)) throw error;
	writeError(
		[
			"invalid configuration:",
			...error.issues.map((issue) => `  ${issue.subject} ${issue.problem}`),
		].join("\n"),
	);
	process.exit(EXIT_CODES.misused);
}

process.exit(await invoke(read.invocation, config));
