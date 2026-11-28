import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Actor } from "@workbench/sdk";
import { z } from "zod";
import { UNKNOWN_FAILURE_REASON } from "./failure-reason.ts";
import { parseJsonText } from "./json-text.ts";
import { LOG_LEVELS, type LogLevel } from "./logger.ts";
import { isPluginName } from "./plugin-name.ts";
import { systemFailureReason } from "./system-error.ts";

const REDACTED = "[redacted]";

export class Secret {
	readonly #value: string;

	constructor(value: string) {
		this.#value = value;
	}

	reveal(): string {
		return this.#value;
	}

	toString(): string {
		return REDACTED;
	}

	toJSON(): string {
		return REDACTED;
	}
}

export type Config = {
	readonly databaseUrl: Secret;
	readonly port: number;
	readonly logLevel: LogLevel;
	readonly readinessTimeoutMs: number;
	readonly pluginHookTimeoutMs: number;
	readonly enabledPlugins: readonly string[];
	readonly instanceAdmins: readonly Actor[];
};

export type ConfigSource = {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly readSecretFile: (path: string) => string;
};

export type ConfigIssue = {
	readonly variable: string;
	readonly problem: string;
};

export class InvalidConfigError extends Error {
	readonly issues: readonly ConfigIssue[];

	constructor(issues: readonly ConfigIssue[]) {
		super(
			`Invalid configuration: ${issues.map((issue) => `${issue.variable} ${issue.problem}`).join("; ")}`,
		);
		this.name = "InvalidConfigError";
		this.issues = issues;
	}
}

type IntegerRange = { readonly min: number; readonly max: number };

const POSTGRES_SCHEMES = ["postgres", "postgresql"] as const;
const PORT_RANGE: IntegerRange = { min: 0, max: 65_535 };
const DEFAULT_PORT = 3000;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const READINESS_TIMEOUT_MS_RANGE: IntegerRange = { min: 1, max: 60_000 };
const DEFAULT_READINESS_TIMEOUT_MS = 2000;
const PLUGIN_HOOK_TIMEOUT_MS_RANGE: IntegerRange = { min: 1, max: 600_000 };
const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 10_000;

function isPostgresUrl(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const { protocol, hostname } = new URL(value);
	return (
		POSTGRES_SCHEMES.some((scheme) => protocol === `${scheme}:`) &&
		hostname !== ""
	);
}

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

function integerIn(range: IntegerRange) {
	return z
		.string()
		.regex(DECIMAL_INTEGER)
		.transform(Number)
		.pipe(z.number().min(range.min).max(range.max));
}

function integerExpectation(range: IntegerRange): string {
	return `must be a decimal integer between ${range.min} and ${range.max}`;
}

const pluginNames = z
	.string()
	.transform((value) => value.split(",").map((name) => name.trim()))
	.pipe(z.array(z.string().refine(isPluginName)));

const serviceAccountIds = z
	.string()
	.transform((value) =>
		value.trim() === "" ? [] : value.split(",").map((id) => id.trim()),
	)
	.pipe(z.array(z.uuid()));

const schema = z.object({
	DATABASE_URL: z.string().refine(isPostgresUrl),
	PORT: integerIn(PORT_RANGE).default(DEFAULT_PORT),
	LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
	READINESS_TIMEOUT_MS: integerIn(READINESS_TIMEOUT_MS_RANGE).default(
		DEFAULT_READINESS_TIMEOUT_MS,
	),
	PLUGIN_HOOK_TIMEOUT_MS: integerIn(PLUGIN_HOOK_TIMEOUT_MS_RANGE).default(
		DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
	),
	PLUGINS: pluginNames.default([]),
	INSTANCE_ADMIN_SERVICE_ACCOUNTS: serviceAccountIds.default([]),
});

type Variable = keyof z.input<typeof schema>;

const EXPECTATIONS: Record<Variable, string> = {
	DATABASE_URL: `must be a ${POSTGRES_SCHEMES.map((scheme) => `${scheme}://`).join(" or ")} URL with a host`,
	PORT: integerExpectation(PORT_RANGE),
	LOG_LEVEL: `must be one of ${LOG_LEVELS.join(", ")}`,
	READINESS_TIMEOUT_MS: integerExpectation(READINESS_TIMEOUT_MS_RANGE),
	PLUGIN_HOOK_TIMEOUT_MS: integerExpectation(PLUGIN_HOOK_TIMEOUT_MS_RANGE),
	PLUGINS:
		"must be a comma-separated list of plugin names (lowercase letters, digits and hyphens, starting with a letter)",
	INSTANCE_ADMIN_SERVICE_ACCOUNTS:
		"must be a comma-separated list of service account IDs (UUIDs)",
};

type ValueOrigin = "variable" | "secretFile";

const MISSING_PROBLEMS: Record<ValueOrigin, string> = {
	variable: "is required",
	secretFile: "names an empty file",
};

type ResolvedValue = {
	readonly origin: ValueOrigin;
	readonly reportedAs: string;
	readonly value: string | undefined;
	readonly expectation: string;
};

function readVariable(
	source: Pick<ConfigSource, "env">,
	variable: string,
): string | undefined {
	const value = source.env[variable];
	return value === undefined || value === "" ? undefined : value;
}

function resolvePlain(source: ConfigSource, variable: Variable): ResolvedValue {
	return {
		origin: "variable",
		reportedAs: variable,
		value: readVariable(source, variable),
		expectation: EXPECTATIONS[variable],
	};
}

function resolveSecret(
	source: ConfigSource,
	variable: Variable,
): ResolvedValue | ConfigIssue {
	const fileVariable = `${variable}_FILE`;
	const path = readVariable(source, fileVariable);
	if (path === undefined) return resolvePlain(source, variable);
	if (readVariable(source, variable) !== undefined) {
		return {
			variable: fileVariable,
			problem: `must not be set together with ${variable}`,
		};
	}
	try {
		const content = source.readSecretFile(path).trim();
		return {
			origin: "secretFile",
			reportedAs: fileVariable,
			value: content === "" ? undefined : content,
			expectation: EXPECTATIONS[variable],
		};
	} catch {
		return {
			variable: fileVariable,
			problem: "names a file that cannot be read",
		};
	}
}

function resolveVariables(
	source: ConfigSource,
): Record<Variable, ResolvedValue | ConfigIssue> {
	return {
		DATABASE_URL: resolveSecret(source, "DATABASE_URL"),
		PORT: resolvePlain(source, "PORT"),
		LOG_LEVEL: resolvePlain(source, "LOG_LEVEL"),
		READINESS_TIMEOUT_MS: resolvePlain(source, "READINESS_TIMEOUT_MS"),
		PLUGIN_HOOK_TIMEOUT_MS: resolvePlain(source, "PLUGIN_HOOK_TIMEOUT_MS"),
		PLUGINS: resolvePlain(source, "PLUGINS"),
		INSTANCE_ADMIN_SERVICE_ACCOUNTS: resolvePlain(
			source,
			"INSTANCE_ADMIN_SERVICE_ACCOUNTS",
		),
	};
}

function isIssue(
	resolved: ResolvedValue | ConfigIssue,
): resolved is ConfigIssue {
	return "problem" in resolved;
}

export function loadConfig(source: ConfigSource): Config {
	const resolved = Object.entries(resolveVariables(source));
	const parsed = schema.safeParse(
		Object.fromEntries(
			resolved.map(([variable, given]) => [
				variable,
				isIssue(given) ? undefined : given.value,
			]),
		),
	);
	const rejected = new Set(
		parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0]),
	);
	const issues = resolved.flatMap(([variable, given]): ConfigIssue[] => {
		if (isIssue(given)) return [given];
		if (!rejected.has(variable)) return [];
		return [
			{
				variable: given.reportedAs,
				problem:
					given.value === undefined
						? MISSING_PROBLEMS[given.origin]
						: given.expectation,
			},
		];
	});
	if (!parsed.success || issues.length > 0)
		throw new InvalidConfigError(issues);

	return {
		databaseUrl: new Secret(parsed.data.DATABASE_URL),
		port: parsed.data.PORT,
		logLevel: parsed.data.LOG_LEVEL,
		readinessTimeoutMs: parsed.data.READINESS_TIMEOUT_MS,
		pluginHookTimeoutMs: parsed.data.PLUGIN_HOOK_TIMEOUT_MS,
		enabledPlugins: parsed.data.PLUGINS,
		instanceAdmins: parsed.data.INSTANCE_ADMIN_SERVICE_ACCOUNTS.map((id) => ({
			kind: "service_account",
			id,
		})),
	};
}

export function loadConfigFromEnvironment(): Config {
	return loadConfig({
		env: process.env,
		readSecretFile: (path) => readFileSync(path, "utf8"),
	});
}

export type CliConfig = {
	readonly instanceUrl: URL;
	readonly token: Secret;
};

export type CliConfigFileContent =
	| { readonly found: "text"; readonly text: string }
	| { readonly found: "missing" }
	| { readonly found: "unreadable" };

export type CliConfigSource = {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly readFile: (path: string) => CliConfigFileContent;
};

export type CliConfigIssue = {
	readonly subject: string;
	readonly problem: string;
};

export class InvalidCliConfigError extends Error {
	readonly issues: readonly CliConfigIssue[];

	constructor(issues: readonly CliConfigIssue[]) {
		super(
			`Invalid configuration of the command line: ${issues.map((issue) => `${issue.subject} ${issue.problem}`).join("; ")}`,
		);
		this.name = "InvalidCliConfigError";
		this.issues = issues;
	}
}

const CLI_CONFIG_FILE = join("workbench", "cli.json");

const INSTANCE_SCHEMES = ["http", "https"] as const;

const MISSING_FILE_REASON = "ENOENT";

const BEARER_TOKEN = /^[!-~]+$/;

const cliConfigFile = z
	.object({ url: z.string().optional(), token: z.string().optional() })
	.strict();

type CliConfigFile = z.infer<typeof cliConfigFile>;

type FoundCliConfigFile = {
	readonly path: string | undefined;
	readonly content: CliConfigFile;
};

type CliConfigFileRead =
	| { readonly read: true; readonly file: FoundCliConfigFile }
	| { readonly read: false; readonly issue: CliConfigIssue };

type Resolved<Value> =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly issue: CliConfigIssue };

type CliValue = {
	readonly value: string;
	readonly reportedAs: string;
};

function isInstanceUrl(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const { protocol, hostname } = new URL(value);
	return (
		INSTANCE_SCHEMES.some((scheme) => protocol === `${scheme}:`) &&
		hostname !== ""
	);
}

function defaultCliConfigPath(source: CliConfigSource): string | undefined {
	const configHome = readVariable(source, "XDG_CONFIG_HOME");
	if (configHome !== undefined) return join(configHome, CLI_CONFIG_FILE);
	const home = readVariable(source, "HOME");
	if (home === undefined) return undefined;
	return join(home, ".config", CLI_CONFIG_FILE);
}

function readCliConfigFile(source: CliConfigSource): CliConfigFileRead {
	const chosen = readVariable(source, "WORKBENCH_CONFIG");
	const path = chosen ?? defaultCliConfigPath(source);
	if (path === undefined) return { read: true, file: { path, content: {} } };
	const content = source.readFile(path);
	switch (content.found) {
		case "missing":
			return chosen === undefined
				? { read: true, file: { path, content: {} } }
				: {
						read: false,
						issue: {
							subject: "WORKBENCH_CONFIG",
							problem: "names a file that does not exist",
						},
					};
		case "unreadable":
			return {
				read: false,
				issue: { subject: path, problem: "cannot be read" },
			};
		case "text":
			return parsedCliConfigFile(path, content.text);
	}
}

function parsedCliConfigFile(path: string, text: string): CliConfigFileRead {
	const json = parseJsonText(text);
	const parsed = cliConfigFile.safeParse(json.parsed ? json.value : undefined);
	if (!parsed.success)
		return {
			read: false,
			issue: {
				subject: path,
				problem:
					"must be a JSON object with no other fields than the strings url and token",
			},
		};
	return { read: true, file: { path, content: parsed.data } };
}

function resolveCliValue(
	source: CliConfigSource,
	variable: string,
	file: FoundCliConfigFile,
	field: keyof CliConfigFile,
): Resolved<CliValue> {
	const fromEnvironment = readVariable(source, variable);
	if (fromEnvironment !== undefined)
		return {
			ok: true,
			value: { value: fromEnvironment, reportedAs: variable },
		};
	const fromFile = file.content[field];
	if (fromFile !== undefined && fromFile !== "")
		return {
			ok: true,
			value: { value: fromFile, reportedAs: `${field} in ${file.path}` },
		};
	const alternative =
		file.path === undefined ? "" : `, or ${field} in ${file.path}`;
	return {
		ok: false,
		issue: { subject: `${variable}${alternative}`, problem: "is required" },
	};
}

function instanceUrlOf(resolved: Resolved<CliValue>): Resolved<URL> {
	if (!resolved.ok) return resolved;
	const { value, reportedAs } = resolved.value;
	if (!isInstanceUrl(value))
		return {
			ok: false,
			issue: {
				subject: reportedAs,
				problem: `must be a ${INSTANCE_SCHEMES.map((scheme) => `${scheme}://`).join(" or ")} URL with a host`,
			},
		};
	return { ok: true, value: new URL(value) };
}

function tokenOf(resolved: Resolved<CliValue>): Resolved<Secret> {
	if (!resolved.ok) return resolved;
	const { value, reportedAs } = resolved.value;
	if (!BEARER_TOKEN.test(value))
		return {
			ok: false,
			issue: {
				subject: reportedAs,
				problem: "must consist of visible ASCII characters only",
			},
		};
	return { ok: true, value: new Secret(value) };
}

export function loadCliConfig(source: CliConfigSource): CliConfig {
	const configFile = readCliConfigFile(source);
	if (!configFile.read) throw new InvalidCliConfigError([configFile.issue]);
	const { file } = configFile;
	const instanceUrl = instanceUrlOf(
		resolveCliValue(source, "WORKBENCH_URL", file, "url"),
	);
	const token = tokenOf(
		resolveCliValue(source, "WORKBENCH_TOKEN", file, "token"),
	);
	if (!instanceUrl.ok || !token.ok)
		throw new InvalidCliConfigError(
			[instanceUrl, token].flatMap((resolved) =>
				resolved.ok ? [] : [resolved.issue],
			),
		);
	return { instanceUrl: instanceUrl.value, token: token.value };
}

export function loadCliConfigFromEnvironment(): CliConfig {
	return loadCliConfig({ env: process.env, readFile: readCliConfigFileText });
}

function readCliConfigFileText(path: string): CliConfigFileContent {
	try {
		return { found: "text", text: readFileSync(path, "utf8") };
	} catch (error) {
		const reason = systemFailureReason(error);
		if (reason === UNKNOWN_FAILURE_REASON) throw error;
		return reason === MISSING_FILE_REASON
			? { found: "missing" }
			: { found: "unreadable" };
	}
}
