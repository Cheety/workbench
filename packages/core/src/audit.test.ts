import { afterEach, describe, expect, test } from "bun:test";
import {
	type Actor,
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
	type OperationContext,
	OperationError,
} from "@workbench/sdk";
import { z } from "zod";
import type { PluginPackage } from "./kernel.ts";
import type { OperationResult } from "./operation-pipeline.ts";
import {
	type OperationHarness,
	type OperationHarnessOptions,
	startOperationHarness,
} from "./testing/operation-harness.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

const AUDITOR: Actor = { kind: "user", id: "auditor" };

const entry = z.object({ id: z.string(), amount: z.number().int() });

const addEntry = defineOperation({
	name: "addEntry",
	kind: "mutation",
	target: "workspace",
	right: "ledger.entry.add",
	input: z.object({ amount: z.number().int() }),
	output: entry,
	execute: async ({ amount }, ctx) => {
		const id = ctx.newId();
		await ctx.sql`INSERT INTO entries (id, workspace_id, amount) VALUES (${id}, ${ctx.workspace}, ${amount})`;
		if (amount === 0)
			throw new OperationError(
				"rejected",
				"zero_amount",
				"an entry needs an amount other than zero",
			);
		if (amount < 0) throw new Error("negative amount");
		return { id, amount };
	},
});

const addMalformedEntry = {
	...addEntry,
	name: "addMalformedEntry",
	execute: async (input: { amount: number }, ctx: OperationContext) => {
		const id = ctx.newId();
		await ctx.sql`INSERT INTO entries (id, workspace_id, amount) VALUES (${id}, ${ctx.workspace}, ${input.amount})`;
		return { id, amount: "a lot" };
	},
};

const listEntries = defineOperation({
	name: "listEntries",
	kind: "query",
	target: "workspace",
	right: "ledger.entry.read",
	input: z.object({}),
	output: z.object({ entries: z.array(entry) }),
	execute: async (_input, ctx) => {
		const rows =
			await ctx.sql`SELECT id, amount FROM entries WHERE workspace_id = ${ctx.workspace} ORDER BY id`;
		return { entries: z.array(entry).parse(rows) };
	},
});

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () => ({
		...definePlugin({
			manifest: { name: "ledger", capabilities: [DATABASE_CAPABILITY] },
		}),
		operations: [addEntry, addMalformedEntry, listEntries],
	}),
	loadMigrations: async () => [
		{
			name: "0001_create_entries.sql",
			sql: "CREATE TABLE entries (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, amount integer NOT NULL);",
		},
	],
};

const ringBell = defineOperation({
	name: "ringBell",
	kind: "mutation",
	target: "workspace",
	right: "bell.bell.ring",
	input: z.object({}),
	output: z.object({ rung: z.boolean() }),
	execute: async () => ({ rung: true }),
});

const bell: PluginPackage = {
	packageName: "@workbench/plugin-bell",
	pluginName: "bell",
	version: "1.0.0",
	loadDefinition: async () =>
		definePlugin({ manifest: { name: "bell" }, operations: [ringBell] }),
};

const harnesses: OperationHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.stop();
});

async function startLedger(
	options: Omit<OperationHarnessOptions, "plugins"> = {},
): Promise<OperationHarness> {
	const harness = await startOperationHarness({
		...options,
		plugins: [ledger, bell],
	});
	harnesses.push(harness);
	return harness;
}

function everyMinuteFrom(start: string): () => Date {
	let minutes = 0;
	return () => new Date(Date.parse(start) + 60_000 * minutes++);
}

function listAuditEntries(
	harness: OperationHarness,
	workspace: string,
): Promise<OperationResult> {
	return harness.call({
		actor: AUDITOR,
		workspace,
		operation: "core.listAuditEntries",
		input: { limit: 10 },
	});
}

describe("the audit of a workspace", () => {
	test("names actor, operation, workspace and time in UTC of a mutation that succeeded", async () => {
		const harness = await startLedger({
			now: () => new Date("2026-11-27T09:30:00.000+01:00"),
		});
		const workspace = await harness.createWorkspace("Accounts");
		await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: 42 },
		});

		const listed = await listAuditEntries(harness, workspace);

		expect(listed).toEqual({
			ok: true,
			output: {
				entries: [
					{
						id: expect.any(String),
						occurredAt: "2026-11-27T08:30:00.000Z",
						actor: { kind: "user", id: "alice" },
						apiTokenId: null,
						operation: "ledger.addEntry",
						workspace,
						result: "succeeded",
					},
				],
			},
		});
	});

	test("holds one entry for each mutation that succeeded, the newest first", async () => {
		const harness = await startLedger({
			now: everyMinuteFrom("2026-11-27T08:00:00.000Z"),
		});
		const workspace = await harness.createWorkspace("Accounts");
		await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: 42 },
		});
		await harness.call({
			actor: { kind: "service_account", id: "agent" },
			workspace,
			operation: "bell.ringBell",
			input: {},
		});

		const listed = await listAuditEntries(harness, workspace);

		expect(listed).toEqual({
			ok: true,
			output: {
				entries: [
					expect.objectContaining({
						occurredAt: "2026-11-27T08:02:00.000Z",
						actor: { kind: "service_account", id: "agent" },
						operation: "bell.ringBell",
					}),
					expect.objectContaining({
						occurredAt: "2026-11-27T08:01:00.000Z",
						actor: { kind: "user", id: "alice" },
						operation: "ledger.addEntry",
					}),
				],
			},
		});
	});

	test("holds no entry for a query", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");
		await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.listEntries",
			input: {},
		});
		await listAuditEntries(harness, workspace);

		const listed = await listAuditEntries(harness, workspace);

		expect(listed).toEqual({ ok: true, output: { entries: [] } });
	});

	test.each([
		["whose execute rejected the call", "ledger.addEntry", { amount: 0 }],
		["whose execute threw", "ledger.addEntry", { amount: -5 }],
		[
			"whose output the schema rejected",
			"ledger.addMalformedEntry",
			{ amount: 5 },
		],
		["whose input was invalid", "ledger.addEntry", { amount: "a lot" }],
	])("holds no entry for a mutation %s", async (_case, operation, input) => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");
		const called = await harness.call({
			actor: ALICE,
			workspace,
			operation,
			input,
		});

		const listed = await listAuditEntries(harness, workspace);

		expect(called.ok).toBe(false);
		expect(listed).toEqual({ ok: true, output: { entries: [] } });
	});

	test("holds only the entries of the workspace it is asked for", async () => {
		const harness = await startLedger();
		const accounts = await harness.createWorkspace("Accounts");
		const archive = await harness.createWorkspace("Archive");
		await harness.call({
			actor: ALICE,
			workspace: accounts,
			operation: "ledger.addEntry",
			input: { amount: 42 },
		});

		const listed = await listAuditEntries(harness, archive);

		expect(listed).toEqual({ ok: true, output: { entries: [] } });
	});
});

describe("a mutation whose audit entry cannot be written", () => {
	test("is rolled back and fails as an internal error", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const added = await harness.call({
			actor: { kind: "user", id: "" },
			workspace,
			operation: "ledger.addEntry",
			input: { amount: 42 },
		});
		const listed = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.listEntries",
			input: {},
		});

		expect(added).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
		expect(listed).toEqual({ ok: true, output: { entries: [] } });
		expect(harness.logEntries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "operation failed",
				operation: "ledger.addEntry",
				reason: "pipeline_failed",
			}),
		);
	});
});
