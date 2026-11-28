import { afterEach, describe, expect, test } from "bun:test";
import { type Actor, defineOperation, definePlugin } from "@workbench/sdk";
import { SQL } from "bun";
import { z } from "zod";
import {
	type OperationHarness,
	type OperationHarnessOptions,
	type PluginPackage,
	startOperationHarness,
} from "./operation-harness.ts";
import { TEST_DATABASE_URL } from "./postgres.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

const AGENT: Actor = { kind: "service_account", id: "agent" };

const describeCall = defineOperation({
	name: "describeCall",
	kind: "query",
	target: "workspace",
	right: "ledger.entry.read",
	input: z.object({}),
	output: z.object({
		actor: z.object({ kind: z.string(), id: z.string() }),
		workspace: z.string(),
		now: z.string(),
		ids: z.array(z.string()),
		random: z.number(),
	}),
	execute: async (_input, ctx) => ({
		actor: ctx.actor,
		workspace: ctx.workspace,
		now: ctx.now().toISOString(),
		ids: [ctx.newId(), ctx.newId()],
		random: ctx.random(),
	}),
});

const drawId = defineOperation({
	name: "drawId",
	kind: "mutation",
	target: "workspace",
	right: "ledger.entry.add",
	input: z.object({}),
	output: z.object({ id: z.string() }),
	execute: async (_input, ctx) => ({ id: ctx.newId() }),
});

const nameDatabase = defineOperation({
	name: "nameDatabase",
	kind: "query",
	target: "workspace",
	right: "ledger.entry.read",
	input: z.object({}),
	output: z.object({ name: z.string() }),
	execute: async (_input, ctx) => {
		const [row] = await ctx.sql`SELECT current_database() AS name`;
		return z.object({ name: z.string() }).parse(row);
	},
});

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () => ({
		...definePlugin({ manifest: { name: "ledger" } }),
		rights: [
			{ name: "ledger.entry.add", defaultRoles: ["owner"] },
			{ name: "ledger.entry.read", defaultRoles: ["owner"] },
		],
		operations: [describeCall, drawId, nameDatabase],
	}),
};

const unstoppable: PluginPackage = {
	packageName: "@workbench/plugin-unstoppable",
	pluginName: "unstoppable",
	version: "1.0.0",
	loadDefinition: async () =>
		definePlugin({
			manifest: { name: "unstoppable" },
			deactivate: () => {
				throw new Error("cannot stop");
			},
		}),
};

async function databaseOf(harness: OperationHarness): Promise<string> {
	const named = await harness.call({
		actor: ALICE,
		workspace: await harness.createWorkspace("Accounts", [
			{ actor: ALICE, role: "owner" },
		]),
		operation: "ledger.nameDatabase",
		input: {},
	});
	return z
		.object({ ok: z.literal(true), output: z.object({ name: z.string() }) })
		.parse(named).output.name;
}

async function existingDatabasesNamed(name: string): Promise<unknown[]> {
	const admin = new SQL(TEST_DATABASE_URL, { max: 1 });
	try {
		return await admin`SELECT datname FROM pg_database WHERE datname = ${name}`;
	} finally {
		await admin.close();
	}
}

const harnesses: OperationHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.stop();
});

async function startLedger(
	options: Omit<OperationHarnessOptions, "plugins"> = {},
): Promise<OperationHarness> {
	const harness = await startOperationHarness({
		...options,
		plugins: [ledger],
	});
	harnesses.push(harness);
	return harness;
}

describe("the operation harness", () => {
	test("has a database of its own while it runs and drops it when stopped", async () => {
		const harness = await startOperationHarness({ plugins: [ledger] });
		const database = await databaseOf(harness);
		const whileRunning = await existingDatabasesNamed(database);

		await harness.stop();

		expect(whileRunning).toEqual([{ datname: database }]);
		expect(await existingDatabasesNamed(database)).toEqual([]);
	});

	test("drops its database when stopped although a plugin fails to deactivate, and logs the failure", async () => {
		const harness = await startOperationHarness({
			plugins: [ledger, unstoppable],
		});
		const database = await databaseOf(harness);

		await harness.stop();

		expect(harness.logEntries).toContainEqual(
			expect.objectContaining({
				message: "plugin failed to deactivate",
				plugin: "unstoppable",
			}),
		);
		expect(await existingDatabasesNamed(database)).toEqual([]);
	});

	test("gives the operation a fixed clock, sequential ids and a fixed random number by default", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", [
			{ actor: ALICE, role: "owner" },
		]);

		const described = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.describeCall",
			input: {},
		});

		expect(workspace).toBe("00000000-0000-4000-8000-000000000001");
		expect(described).toEqual({
			ok: true,
			output: {
				actor: { kind: "user", id: "alice" },
				workspace: "00000000-0000-4000-8000-000000000001",
				now: "2026-11-26T08:00:00.000Z",
				ids: [
					"00000000-0000-4000-8000-000000000002",
					"00000000-0000-4000-8000-000000000003",
				],
				random: 0.5,
			},
		});
	});

	test("gives the operation the clock, ids and random numbers a test passes", async () => {
		const ids = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333",
		];
		const harness = await startLedger({
			now: () => new Date("2030-01-02T03:04:05.000Z"),
			newId: () => ids.shift() ?? "exhausted",
			random: () => 0.25,
		});
		const workspace = await harness.createWorkspace("Accounts", [
			{ actor: AGENT, role: "owner" },
		]);

		const described = await harness.call({
			actor: AGENT,
			workspace,
			operation: "ledger.describeCall",
			input: {},
		});

		expect(described).toEqual({
			ok: true,
			output: {
				actor: { kind: "service_account", id: "agent" },
				workspace: "11111111-1111-4111-8111-111111111111",
				now: "2030-01-02T03:04:05.000Z",
				ids: [
					"22222222-2222-4222-8222-222222222222",
					"33333333-3333-4333-8333-333333333333",
				],
				random: 0.25,
			},
		});
	});

	test("draws the ids of audit entries from a sequence of their own, so a mutation does not shift the ids of the next operation", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", [
			{ actor: ALICE, role: "owner" },
		]);
		const call = {
			actor: ALICE,
			workspace,
			operation: "ledger.drawId",
			input: {},
		};

		const first = await harness.call(call);
		const second = await harness.call(call);
		const audit = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.listAuditEntries",
			input: { limit: 10, cursor: null },
		});

		expect([first, second]).toEqual([
			{ ok: true, output: { id: "00000000-0000-4000-8000-000000000002" } },
			{ ok: true, output: { id: "00000000-0000-4000-8000-000000000003" } },
		]);
		expect(audit).toEqual({
			ok: true,
			output: {
				entries: [
					expect.objectContaining({
						id: "00000000-0000-4000-a000-000000000002",
					}),
					expect.objectContaining({
						id: "00000000-0000-4000-a000-000000000001",
					}),
				],
				nextCursor: null,
			},
		});
	});

	test("gives audit entries the ids a test passes", async () => {
		const ids = [
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		];
		const harness = await startLedger({
			newAuditEntryId: () => ids.shift() ?? "exhausted",
		});
		const workspace = await harness.createWorkspace("Accounts", [
			{ actor: ALICE, role: "owner" },
		]);
		await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.drawId",
			input: {},
		});

		const audit = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.listAuditEntries",
			input: { limit: 10, cursor: null },
		});

		expect(audit).toEqual({
			ok: true,
			output: {
				entries: [
					expect.objectContaining({
						id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					}),
				],
				nextCursor: null,
			},
		});
	});
});
