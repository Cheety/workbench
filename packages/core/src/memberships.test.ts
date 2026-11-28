import { afterEach, describe, expect, test } from "bun:test";
import { type Actor, defineOperation, definePlugin } from "@workbench/sdk";
import { SQL } from "bun";
import { z } from "zod";
import { Secret } from "./config.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { isInstanceAdminOf } from "./instance-admins.ts";
import { type PluginPackage, startPlugins } from "./kernel.ts";
import { grantMembership } from "./memberships.ts";
import {
	createOperationPipeline,
	type OperationPipeline,
	type OperationResult,
} from "./operation-pipeline.ts";
import { roleName } from "./role-name.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "./schema-migrations.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";
import { createWorkspace } from "./workspaces.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

const ADMIN: Actor = { kind: "service_account", id: "admin" };

const WORKSPACE = "00000000-0000-4000-8000-00000000aaaa";

const NOT_STOPPED = new AbortController().signal;

type Gate = {
	readonly entered: Promise<void>;
	pass(): Promise<void>;
	open(): void;
};

function gate(): Gate {
	const entered = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<void>();
	return {
		entered: entered.promise,
		pass: () => {
			entered.resolve();
			return opened.promise;
		},
		open: () => opened.resolve(),
	};
}

function bellRungBehind(behind: Gate): PluginPackage {
	const ringBell = defineOperation({
		name: "ringBell",
		kind: "mutation",
		target: "workspace",
		right: "bell.bell.ring",
		input: z.object({}),
		output: z.object({ rung: z.boolean() }),
		execute: async () => {
			await behind.pass();
			return { rung: true };
		},
	});
	return {
		packageName: "@workbench/plugin-bell",
		pluginName: "bell",
		version: "1.0.0",
		loadDefinition: async () =>
			definePlugin({
				manifest: { name: "bell" },
				rights: [{ name: "bell.bell.ring", defaultRoles: ["owner"] }],
				operations: [ringBell],
			}),
	};
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startBellPipeline(
	database: FreshDatabase,
	plugin: PluginPackage,
): Promise<OperationPipeline> {
	const { logger } = recordingLogger();
	const runner: MigrationRunner = {
		databaseUrl: new Secret(database.url),
		connectionTimeoutMs: 10_000,
		statementTimeoutMs: 60_000,
		lockRetryDelayMs: () => 0,
		setTimer: setSystemTimer,
		logger,
	};
	await migrateCoreSchema(runner, CORE_MIGRATIONS_DIRECTORY, NOT_STOPPED);
	const plugins = await startPlugins({
		discover: async () => ({ packages: [plugin], unreadable: [] }),
		enabledPlugins: ["bell"],
		capabilityProviders: {},
		migrateSchemas: (schemas) => migrateSchemas(runner, schemas, NOT_STOPPED),
		hookTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
	cleanups.push(async () => {
		await plugins.deactivate();
	});
	const createdAt = new Date("2026-11-28T09:00:00.000Z");
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Accounts",
		createdAt,
	});
	await grantMembership(database.sql, {
		workspace: WORKSPACE,
		actor: ALICE,
		role: roleName("owner"),
		createdAt,
	});
	const pool = new SQL(database.url, { max: 2 });
	cleanups.push(() => pool.close());
	return createOperationPipeline({
		sql: pool,
		registry: plugins.operations,
		events: plugins.events,
		jobs: plugins.jobs,
		now: () => createdAt,
		newId: () => crypto.randomUUID(),
		newAuditEntryId: () => crypto.randomUUID(),
		newEventId: () => crypto.randomUUID(),
		newJobId: () => crypto.randomUUID(),
		eventsCommitted: () => {},
		jobsCommitted: () => {},
		random: () => 0.5,
		isInstanceAdmin: isInstanceAdminOf([ADMIN]),
		logger,
	});
}

function lockingTheMembership(database: FreshDatabase): Promise<unknown> {
	return database.sql.begin(
		(transaction) => transaction`
			SELECT role FROM core.memberships
			WHERE workspace_id = ${WORKSPACE} AND actor_kind = ${ALICE.kind} AND actor_id = ${ALICE.id}
			FOR UPDATE NOWAIT`,
	);
}

describe("the membership checked for a mutation", () => {
	test("cannot be revoked while the mutation runs", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		const behind = gate();
		const pipeline = await startBellPipeline(database, bellRungBehind(behind));
		const ringing: Promise<OperationResult> = pipeline.invoke({
			operation: "bell.ringBell",
			actor: ALICE,
			apiTokenId: null,
			idempotencyKey: null,
			workspace: WORKSPACE,
			input: {},
			correlationId: "call-1",
		});
		await behind.entered;

		const revoked = await lockingTheMembership(database).then(
			() => "revoked",
			(error: unknown) => (error instanceof Error ? error.message : error),
		);
		behind.open();

		expect(revoked).toStartWith("could not obtain lock on row");
		expect(await ringing).toEqual({ ok: true, output: { rung: true } });
	});

	test("keeps its role from being redefined while the mutation runs", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		const behind = gate();
		const pipeline = await startBellPipeline(database, bellRungBehind(behind));
		const ringing: Promise<OperationResult> = pipeline.invoke({
			operation: "bell.ringBell",
			actor: ALICE,
			apiTokenId: null,
			idempotencyKey: null,
			workspace: WORKSPACE,
			input: {},
			correlationId: "call-1",
		});
		await behind.entered;

		const redefined = await database.sql
			.begin(
				(transaction) => transaction`
					SELECT name FROM core.roles WHERE name = 'owner' FOR UPDATE NOWAIT`,
			)
			.then(
				() => "redefined",
				(error: unknown) => (error instanceof Error ? error.message : error),
			);
		behind.open();

		expect(redefined).toStartWith("could not obtain lock on row");
		expect(await ringing).toEqual({ ok: true, output: { rung: true } });
	});

	test("keeps its custom role from being redefined through core.defineRole while the mutation runs", async () => {
		const database = await createFreshDatabase();
		cleanups.push(() => database.drop());
		const behind = gate();
		const pipeline = await startBellPipeline(database, bellRungBehind(behind));
		const invoke = (
			actor: Actor,
			operation: string,
			workspace: string | null,
			input: unknown,
		): Promise<OperationResult> =>
			pipeline.invoke({
				operation,
				actor,
				apiTokenId: null,
				idempotencyKey: null,
				workspace,
				input,
				correlationId: operation,
			});
		await invoke(ADMIN, "core.defineRole", null, {
			name: "ringer",
			rights: ["bell.bell.ring"],
		});
		await invoke(ADMIN, "core.grantMembership", WORKSPACE, {
			actor: ALICE,
			role: "ringer",
		});
		const ringing = invoke(ALICE, "bell.ringBell", WORKSPACE, {});
		await behind.entered;
		const redefining = invoke(ADMIN, "core.defineRole", null, {
			name: "ringer",
			rights: [],
		});

		const first = await lockWaitOrEnd(database, redefining);
		behind.open();

		expect(first).toBe("waiting for a lock");
		expect(await ringing).toEqual({ ok: true, output: { rung: true } });
		expect(await redefining).toEqual({
			ok: true,
			output: { name: "ringer", rights: [] },
		});
	});
});

async function lockWaitOrEnd(
	database: FreshDatabase,
	call: Promise<OperationResult>,
): Promise<"waiting for a lock" | "ended"> {
	let hasEnded = false;
	void call.then(() => {
		hasEnded = true;
	});
	while (!hasEnded) {
		const waiting = await database.sql`
			SELECT pid FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`;
		if (waiting.length > 0) return "waiting for a lock";
	}
	return "ended";
}
