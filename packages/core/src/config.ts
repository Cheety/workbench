import { readFileSync } from "node:fs";
import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const REDACTED = "[redacted]";

/**
 * A configuration value that must never reach logs, error messages or
 * serialized output. Only `reveal()` hands out the raw value.
 */
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

/** Validated configuration of one instance. Durations are in milliseconds. */
export type Config = {
	readonly databaseUrl: Secret;
	readonly port: number;
	readonly logLevel: LogLevel;
	readonly readinessTimeoutMs: number;
};

export type ConfigSource = {
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Returns the content of a secret file; throws when it cannot be read. */
	readonly readSecretFile: (path: string) => string;
};

/** One rejected variable. `problem` never contains the variable's value. */
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

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

function isPostgresUrl(value: string): boolean {
	return URL.canParse(value) && POSTGRES_PROTOCOLS.has(new URL(value).protocol);
}

const schema = z.object({
	DATABASE_URL: z.string().refine(isPostgresUrl),
	PORT: z.coerce.number().int().min(0).max(65535).default(3000),
	LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
	READINESS_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.min(1)
		.max(60_000)
		.default(2000),
});

type Variable = keyof z.input<typeof schema>;

// Problems are reported from this table instead of from the validator's own
// messages, so that no rejected value can ever end up in the output.
const EXPECTATIONS: Record<Variable, string> = {
	DATABASE_URL: "must be a postgres:// or postgresql:// URL",
	PORT: "must be an integer between 0 and 65535",
	LOG_LEVEL: `must be one of ${LOG_LEVELS.join(", ")}`,
	READINESS_TIMEOUT_MS: "must be an integer between 1 and 60000",
};

const SECRET_VARIABLES = [
	"DATABASE_URL",
] as const satisfies readonly Variable[];
const PLAIN_VARIABLES = [
	"PORT",
	"LOG_LEVEL",
	"READINESS_TIMEOUT_MS",
] as const satisfies readonly Variable[];

type ResolvedValue = {
	/** The variable the operator actually set, used when reporting problems. */
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

/**
 * Resolves a secret from `NAME` or, following the Docker secrets convention,
 * from the file named by `NAME_FILE`.
 */
function resolveSecret(
	source: ConfigSource,
	variable: Variable,
): ResolvedValue | ConfigIssue {
	const fileVariable = `${variable}_FILE`;
	const direct = readVariable(source, variable);
	const path = readVariable(source, fileVariable);
	if (path === undefined) return { reportedAs: variable, value: direct };
	if (direct !== undefined) {
		return {
			variable: fileVariable,
			problem: `must not be set together with ${variable}`,
		};
	}
	try {
		const content = source.readSecretFile(path).trim();
		return {
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

/**
 * Builds the typed configuration from the given source.
 *
 * @throws InvalidConfigError naming every missing or invalid variable.
 */
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
			const origin = resolved.get(variable);
			if (origin === undefined) continue;
			issues.push({
				variable: origin.reportedAs,
				problem:
					origin.value === undefined
						? missingProblem(origin)
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

function missingProblem(origin: ResolvedValue): string {
	return origin.reportedAs.endsWith("_FILE")
		? "names an empty file"
		: "is required";
}

/** Reads the configuration of this process from its environment. */
export function loadConfigFromEnvironment(): Config {
	return loadConfig({
		env: process.env,
		readSecretFile: (path) => readFileSync(path, "utf8"),
	});
}
