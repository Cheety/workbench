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

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () => ({
		...definePlugin({ manifest: { name: "ledger" } }),
		operations: [describeCall],
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
				const error = new Error("cannot stop");
				Object.defineProperty(error, "message", {
					get: () => {
						throw new Error("cannot describe why it cannot stop");
					},
				});
				throw error;
			},
		}),
};

async function countTestDatabases(): Promise<number> {
	const admin = new SQL(TEST_DATABASE_URL, { max: 1 });
	const [row] =
		await admin`SELECT count(*)::int AS databases FROM pg_database WHERE datname LIKE 'workbench\_test\_%'`;
	await admin.close();
	return z.object({ databases: z.number() }).parse(row).databases;
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
	test("drops its database even when deactivating the plugins fails", async () => {
		const databases = await countTestDatabases();
		const harness = await startOperationHarness({ plugins: [unstoppable] });

		const stopped = harness.stop();

		await expect(stopped).rejects.toThrow("cannot describe why it cannot stop");
		expect(await countTestDatabases()).toBe(databases);
	});

	test("gives the operation a fixed clock, sequential ids and a fixed random number by default", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

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
		const workspace = await harness.createWorkspace("Accounts");

		const described = await harness.call({
			actor: { kind: "service_account", id: "agent" },
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
});
