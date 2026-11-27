import { parseArgs } from "node:util";
import { SQL } from "bun";
import { z } from "zod";
import { newApiToken } from "./api-tokens.ts";
import {
	type Config,
	InvalidConfigError,
	loadConfigFromEnvironment,
} from "./config.ts";
import { describeThrown } from "./failure-reason.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { createLogger, type Logger } from "./logger.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	migrateCoreSchema,
} from "./schema-migrations.ts";
import {
	checkValidDays,
	createServiceAccount,
	InvalidValidDaysError,
	MAX_VALID_DAYS,
} from "./service-accounts.ts";

const USAGE = `usage: create-service-account --name <name> --valid-days <1-${MAX_VALID_DAYS}>`;

const CONNECTION_TIMEOUT_MS = 10_000;

const STATEMENT_TIMEOUT_MS = 60_000;

const MIGRATION_LOCK_RETRY_MS = 1000;

const NOT_STOPPED = new AbortController().signal;

const now = (): Date => new Date();

const request = z.object({
	name: z.string().trim().min(1).max(200),
	validDays: z
		.string()
		.regex(/^[1-9][0-9]*$/)
		.transform(Number),
});

type ServiceAccountRequest = z.infer<typeof request>;

function readRequest(
	args: readonly string[],
): ServiceAccountRequest | undefined {
	try {
		const { values } = parseArgs({
			args: [...args],
			options: {
				name: { type: "string" },
				"valid-days": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		});
		const parsed = request.safeParse({
			name: values.name,
			validDays: values["valid-days"],
		});
		if (!parsed.success) return undefined;
		checkValidDays(parsed.data.validDays);
		return parsed.data;
	} catch (error) {
		if (error instanceof TypeError || error instanceof InvalidValidDaysError)
			return undefined;
		throw error;
	}
}

function abort(
	logger: Logger,
	message: string,
	details: Record<string, unknown>,
): never {
	logger.error(message, details);
	process.exit(1);
}

const logger = createLogger({
	level: "info",
	now,
	write: (line) => process.stderr.write(`${line}\n`),
});

const wanted = readRequest(Bun.argv.slice(2));
if (wanted === undefined) {
	process.stderr.write(`${USAGE}\n`);
	process.exit(1);
}

let config: Config;
try {
	config = loadConfigFromEnvironment();
} catch (error) {
	if (!(error instanceof InvalidConfigError)) throw error;
	abort(logger, "invalid configuration, not creating a service account", {
		issues: error.issues,
	});
}

const migrated = await migrateCoreSchema(
	{
		databaseUrl: config.databaseUrl,
		connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
		statementTimeoutMs: STATEMENT_TIMEOUT_MS,
		lockRetryDelayMs: () => MIGRATION_LOCK_RETRY_MS,
		setTimer: setSystemTimer,
		logger,
	},
	CORE_MIGRATIONS_DIRECTORY,
	NOT_STOPPED,
).catch((error: unknown) =>
	abort(logger, "service account not created", {
		reason: "core_schema_not_migrated",
		error: describeThrown(error),
	}),
);
if (migrated !== "migrated")
	abort(logger, "service account not created", {
		reason: "core_schema_not_migrated",
	});

const sql = new SQL(config.databaseUrl.reveal(), {
	max: 1,
	connectionTimeout: CONNECTION_TIMEOUT_MS / 1000,
	connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
});
const created = await createServiceAccount(
	sql,
	{
		name: wanted.name,
		validDays: wanted.validDays,
	},
	{
		now,
		newId: () => crypto.randomUUID(),
		newToken: () =>
			newApiToken((length) => crypto.getRandomValues(new Uint8Array(length))),
	},
)
	.finally(() => sql.close())
	.catch((error: unknown) =>
		abort(logger, "service account not created", {
			reason: "database_failed",
			error: describeThrown(error),
		}),
	);
process.stdout.write(
	`${JSON.stringify({
		serviceAccount: created.serviceAccountId,
		token: created.token.reveal(),
		expiresAt: created.expiresAt.toISOString(),
	})}\n`,
);
