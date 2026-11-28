import type { Actor, OperationKind } from "@workbench/sdk";
import { SQL } from "bun";
import { authenticateToken } from "../api-tokens.ts";
import { Secret } from "../config.ts";
import { setSystemTimer } from "../hook-timeout.ts";
import type { HttpApi } from "../http-api.ts";
import { isInstanceAdminOf } from "../instance-admins.ts";
import { type PluginPackage, startPlugins } from "../kernel.ts";
import { grantMembership } from "../memberships.ts";
import {
	createOperationPipeline,
	type OperationPipeline,
} from "../operation-pipeline.ts";
import { roleName } from "../role-name.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "../schema-migrations.ts";
import { startServer } from "../server.ts";
import { createServiceAccount } from "../service-accounts.ts";
import { createWorkspace } from "../workspaces.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	PostgresGate,
} from "./postgres.ts";
import { type LogEntry, recordingLogger } from "./recording-logger.ts";

export const API_INSTANCE_WORKSPACE = "00000000-0000-4000-8000-00000000aaaa";

const NOW = new Date("2026-11-26T08:00:00.000Z");

const NOT_STOPPED = new AbortController().signal;

export type IdentifiedToken = {
	readonly token: string;
	readonly serviceAccountId: string;
	readonly apiTokenId: string;
};

export class UnidentifiedApiTokenError extends Error {
	constructor(tokensFound: number) {
		super(
			`the new service account has ${tokensFound} API tokens, expected exactly one`,
		);
		this.name = "UnidentifiedApiTokenError";
	}
}

export type OperationListed = {
	readonly name: string;
	readonly kind: OperationKind;
};

export type ApiInstance = {
	readonly url: string;
	readonly registeredOperations: readonly OperationListed[];
	readonly database: FreshDatabase;
	readonly logEntries: readonly LogEntry[];
	readonly invoke: OperationPipeline["invoke"];
	refuseAuthenticationDatabase(): void;
	issueToken(role: string): Promise<string>;
	issueIdentifiedToken(role: string): Promise<IdentifiedToken>;
	issueInstanceAdminToken(): Promise<IdentifiedToken>;
	setClock(now: Date): void;
	post(
		path: string,
		body: string,
		headers: Headers | Record<string, string>,
	): Promise<Response>;
	send(method: string, path: string): Promise<Response>;
	stop(): Promise<void>;
};

export async function startApiInstance(
	plugins: readonly PluginPackage[],
): Promise<ApiInstance> {
	const cleanups: (() => Promise<void>)[] = [];
	const stop = async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	};
	try {
		return await startedApiInstance(plugins, cleanups, stop);
	} catch (error) {
		await stop();
		throw error;
	}
}

async function startedApiInstance(
	plugins: readonly PluginPackage[],
	cleanups: (() => Promise<void>)[],
	stop: () => Promise<void>,
): Promise<ApiInstance> {
	const { logger, entries } = recordingLogger();
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	const authenticationGate = PostgresGate.create(database.url);
	authenticationGate.forward();
	const authenticationSql = new SQL(authenticationGate.url, {
		max: 1,
		connectionTimeout: 10,
	});
	cleanups.push(async () => {
		await authenticationSql.close();
		authenticationGate.close();
	});
	const runner: MigrationRunner = {
		databaseUrl: new Secret(database.url),
		connectionTimeoutMs: 10_000,
		statementTimeoutMs: 60_000,
		lockRetryDelayMs: () => 0,
		setTimer: setSystemTimer,
		logger,
	};
	await migrateCoreSchema(runner, CORE_MIGRATIONS_DIRECTORY, NOT_STOPPED);
	const running = await startPlugins({
		discover: async () => ({ packages: plugins, unreadable: [] }),
		enabledPlugins: plugins.map((plugin) => plugin.pluginName),
		capabilityProviders: {},
		migrateSchemas: (schemas) => migrateSchemas(runner, schemas, NOT_STOPPED),
		hookTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
	cleanups.push(async () => {
		await running.deactivate();
	});
	await createWorkspace(database.sql, {
		id: API_INSTANCE_WORKSPACE,
		name: "Accounts",
		createdAt: NOW,
	});
	let issuedIds = 0;
	const newId = () => {
		issuedIds += 1;
		return `00000000-0000-4000-8000-${String(issuedIds).padStart(12, "0")}`;
	};
	let clock = NOW;
	const instanceAdmins: Actor[] = [];
	const isInstanceAdmin = isInstanceAdminOf(instanceAdmins);
	let issuedTokens = 0;
	let createdTokens = 0;
	let issuedCorrelationIds = 0;
	const api: HttpApi = {
		authenticate: (token) => authenticateToken(authenticationSql, token, clock),
		pipeline: createOperationPipeline({
			sql: database.sql,
			registry: running.operations,
			events: running.events,
			now: () => clock,
			newId,
			newAuditEntryId: newId,
			newEventId: newId,
			eventsCommitted: () => {},
			jobs: running.jobs,
			newJobId: newId,
			jobsCommitted: () => {},
			random: () => 0.5,
			newApiToken: () => {
				createdTokens += 1;
				return new Secret(`wbt_created-token-${createdTokens}`);
			},
			isInstanceAdmin,
			logger,
		}),
		operations: running.operations,
	};
	const server = startServer({
		port: 0,
		logger,
		checkDatabase: async () => ({ reachable: true }),
		newCorrelationId: () => {
			issuedCorrelationIds += 1;
			return `request-${issuedCorrelationIds}`;
		},
		startupStatus: () => "started",
		api,
	});
	cleanups.push(() => server.stop());
	const url = `http://127.0.0.1:${server.port}`;
	const issueAccount = async (): Promise<IdentifiedToken> => {
		issuedTokens += 1;
		const issued = await createServiceAccount(
			database.sql,
			{ name: `agent ${issuedTokens}`, validDays: 30 },
			{
				now: () => clock,
				newId,
				newToken: () => new Secret(`wbt_test-token-${issuedTokens}`),
			},
		);
		const tokens: { id: string }[] =
			await database.sql`SELECT id FROM core.api_tokens WHERE service_account_id = ${issued.serviceAccountId}`;
		const [apiToken, ...unexpected] = tokens;
		if (apiToken === undefined || unexpected.length > 0)
			throw new UnidentifiedApiTokenError(tokens.length);
		return {
			token: issued.token.reveal(),
			serviceAccountId: issued.serviceAccountId,
			apiTokenId: apiToken.id,
		};
	};
	const issueIdentifiedToken = async (
		role: string,
	): Promise<IdentifiedToken> => {
		const issued = await issueAccount();
		await grantMembership(database.sql, {
			workspace: API_INSTANCE_WORKSPACE,
			actor: { kind: "service_account", id: issued.serviceAccountId },
			role: roleName(role),
			createdAt: clock,
		});
		return issued;
	};
	return {
		url,
		registeredOperations: running.operations
			.list()
			.map(({ name, kind }) => ({ name, kind })),
		database,
		logEntries: entries,
		invoke: (call) => api.pipeline.invoke(call),
		refuseAuthenticationDatabase: () => authenticationGate.refuse(),
		issueToken: async (role) => (await issueIdentifiedToken(role)).token,
		issueIdentifiedToken,
		issueInstanceAdminToken: async () => {
			const issued = await issueAccount();
			instanceAdmins.push({
				kind: "service_account",
				id: issued.serviceAccountId,
			});
			return issued;
		},
		setClock: (now) => {
			clock = now;
		},
		post: (path, body, headers) =>
			fetch(`${url}${path}`, { method: "POST", body, headers }),
		send: (method, path) => fetch(`${url}${path}`, { method }),
		stop,
	};
}
