import { readFileSync } from "node:fs";
import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "./logger.ts";

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

const schema = z.object({
	DATABASE_URL: z.string().refine(isPostgresUrl),
	PORT: integerIn(PORT_RANGE).default(DEFAULT_PORT),
	LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
	READINESS_TIMEOUT_MS: integerIn(READINESS_TIMEOUT_MS_RANGE).default(
		DEFAULT_READINESS_TIMEOUT_MS,
	),
});

type Variable = keyof z.input<typeof schema>;

const EXPECTATIONS: Record<Variable, string> = {
	DATABASE_URL: `must be a ${POSTGRES_SCHEMES.map((scheme) => `${scheme}://`).join(" or ")} URL with a host`,
	PORT: integerExpectation(PORT_RANGE),
	LOG_LEVEL: `must be one of ${LOG_LEVELS.join(", ")}`,
	READINESS_TIMEOUT_MS: integerExpectation(READINESS_TIMEOUT_MS_RANGE),
};

const SECRET_VARIABLES = [
	"DATABASE_URL",
] as const satisfies readonly Variable[];
const PLAIN_VARIABLES = [
	"PORT",
	"LOG_LEVEL",
	"READINESS_TIMEOUT_MS",
] as const satisfies readonly Variable[];

type ValueOrigin = "variable" | "secretFile";

const MISSING_PROBLEMS: Record<ValueOrigin, string> = {
	variable: "is required",
	secretFile: "names an empty file",
};

type ResolvedValue = {
	readonly origin: ValueOrigin;
	readonly reportedAs: string;
	readonly value: string | undefined;
};

function readVariable(
	source: ConfigSource,
	variable: string,
): string | undefined {
	const value = source.env[variable];
	return value === undefined || value === "" ? undefined : value;
}

function resolveSecret(
	source: ConfigSource,
	variable: Variable,
): ResolvedValue | ConfigIssue {
	const fileVariable = `${variable}_FILE`;
	const direct = readVariable(source, variable);
	const path = readVariable(source, fileVariable);
	if (path === undefined)
		return { origin: "variable", reportedAs: variable, value: direct };
	if (direct !== undefined) {
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
		};
	} catch {
		return {
			variable: fileVariable,
			problem: "names a file that cannot be read",
		};
	}
}

function isIssue(
	resolved: ResolvedValue | ConfigIssue,
): resolved is ConfigIssue {
	return "problem" in resolved;
}

export function loadConfig(source: ConfigSource): Config {
	const issues: ConfigIssue[] = [];
	const resolved = new Map<Variable, ResolvedValue>();
	for (const variable of SECRET_VARIABLES) {
		const secret = resolveSecret(source, variable);
		if (isIssue(secret)) issues.push(secret);
		else resolved.set(variable, secret);
	}
	for (const variable of PLAIN_VARIABLES) {
		resolved.set(variable, {
			origin: "variable",
			reportedAs: variable,
			value: readVariable(source, variable),
		});
	}

	const input = Object.fromEntries(
		[...resolved].map(([variable, { value }]) => [variable, value]),
	);
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		const rejected = new Set(
			parsed.error.issues.map((issue) => issue.path[0] as Variable),
		);
		for (const variable of rejected) {
			const given = resolved.get(variable);
			if (given === undefined) continue;
			issues.push({
				variable: given.reportedAs,
				problem:
					given.value === undefined
						? MISSING_PROBLEMS[given.origin]
						: EXPECTATIONS[variable],
			});
		}
	}
	if (!parsed.success || issues.length > 0)
		throw new InvalidConfigError(issues);

	return {
		databaseUrl: new Secret(parsed.data.DATABASE_URL),
		port: parsed.data.PORT,
		logLevel: parsed.data.LOG_LEVEL,
		readinessTimeoutMs: parsed.data.READINESS_TIMEOUT_MS,
	};
}

export function loadConfigFromEnvironment(): Config {
	return loadConfig({
		env: process.env,
		readSecretFile: (path) => readFileSync(path, "utf8"),
	});
}
