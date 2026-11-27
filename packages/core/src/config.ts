import { readFileSync } from "node:fs";
import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "./logger.ts";
import { isPluginName } from "./plugin-name.ts";

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
	source: ConfigSource,
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
	};
}

export function loadConfigFromEnvironment(): Config {
	return loadConfig({
		env: process.env,
		readSecretFile: (path) => readFileSync(path, "utf8"),
	});
}
