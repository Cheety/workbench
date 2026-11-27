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
import {
	type OperationHarness,
	type OperationHarnessOptions,
	startOperationHarness,
} from "./testing/operation-harness.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

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
		if (amount < 0) throw new Error("negative amount at /srv/ledger/entries");
		return { id, amount, internalNote: "dropped by the output schema" };
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

const addEntryWhileReading = defineOperation({
	...listEntries,
	name: "sneakEntry",
	execute: async (_input, ctx) => {
		await ctx.sql`INSERT INTO entries (id, workspace_id, amount) VALUES (${ctx.newId()}, ${ctx.workspace}, 1)`;
		return { entries: [] };
	},
});

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

const auditEntries = defineOperation({
	...listEntries,
	name: "auditEntries",
	input: {
		"~standard": {
			version: 1,
			vendor: "ledger",
			validate: () => {
				throw new Error("the audit schema is broken");
			},
		},
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
		operations: [
			addEntry,
			addMalformedEntry,
			listEntries,
			addEntryWhileReading,
			describeCall,
			auditEntries,
		],
	}),
	loadMigrations: async () => [
		{
			name: "0001_create_entries.sql",
			sql: "CREATE TABLE entries (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, amount integer NOT NULL);",
		},
	],
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
		plugins: [ledger],
	});
	harnesses.push(harness);
	return harness;
}

describe("an actor calling an operation", () => {
	test("reads with a query what a mutation wrote", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		await harness.call({
			actor: ALICE,
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

		expect(listed).toEqual({
			ok: true,
			output: {
				entries: [{ id: "00000000-0000-4000-8000-000000000002", amount: 42 }],
			},
		});
	});

	test("receives only what the output schema maps", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const added = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: 7 },
		});

		expect(added).toEqual({
			ok: true,
			output: { id: "00000000-0000-4000-8000-000000000002", amount: 7 },
		});
	});

	test("is told invalid_input with the issues when the input does not match the schema", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const added = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: "a lot" },
		});

		expect(added).toEqual({
			ok: false,
			failure: {
				code: "invalid_input",
				kind: "invalid_input",
				detail: "the input does not match the input schema of the operation",
				issues: [
					{
						path: ["amount"],
						message: "Invalid input: expected number, received string",
					},
				],
			},
		});
	});

	test("finds nothing written by a mutation whose use case failed", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const added = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: 0 },
		});
		const listed = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.listEntries",
			input: {},
		});

		expect(added).toEqual({
			ok: false,
			failure: {
				code: "ledger.zero_amount",
				kind: "rejected",
				detail: "an entry needs an amount other than zero",
				issues: [],
			},
		});
		expect(listed).toEqual({ ok: true, output: { entries: [] } });
	});

	test("is told internal_error without internals when the use case throws unexpectedly, and the log has the details", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const added = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: -5 },
		});
		const listed = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.listEntries",
			input: {},
		});

		expect(added).toEqual({
			ok: false,
			failure: {
				code: "internal_error",
				kind: "internal",
				detail: "the operation failed for an internal reason",
				issues: [],
			},
		});
		expect(listed).toEqual({ ok: true, output: { entries: [] } });
		expect(harness.logEntries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "operation failed",
				correlationId: "harness-call-1",
				operation: "ledger.addEntry",
				reason: "use_case_failed",
				error: expect.objectContaining({
					name: "Error",
					message: "negative amount at /srv/ledger/entries",
				}),
			}),
		);
	});

	test("is told internal_error when the pipeline fails outside the use case, and the log tells it apart from a failed use case", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const audited = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.auditEntries",
			input: {},
		});

		expect(audited).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
		expect(harness.logEntries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "operation failed",
				operation: "ledger.auditEntries",
				reason: "pipeline_failed",
				error: expect.objectContaining({
					message: "the audit schema is broken",
				}),
			}),
		);
	});

	test("is told internal_error and finds nothing written when the use case returns an output the schema rejects", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const added = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addMalformedEntry",
			input: { amount: 5 },
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
				message: "operation failed",
				operation: "ledger.addMalformedEntry",
				reason: "invalid_output",
			}),
		);
	});

	test("cannot write from a query", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const sneaked = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.sneakEntry",
			input: {},
		});
		const listed = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.listEntries",
			input: {},
		});

		expect(sneaked).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
		expect(listed).toEqual({ ok: true, output: { entries: [] } });
		expect(harness.logEntries).toContainEqual(
			expect.objectContaining({
				message: "operation failed",
				operation: "ledger.sneakEntry",
				error: expect.objectContaining({
					message: "cannot execute INSERT in a read-only transaction",
				}),
			}),
		);
	});

	test("is told unknown_operation for a name no active plugin registered", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const called = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.closeBooks",
			input: {},
		});

		expect(called).toEqual({
			ok: false,
			failure: {
				code: "unknown_operation",
				kind: "not_found",
				detail: 'no operation is named "ledger.closeBooks"',
				issues: [],
			},
		});
	});

	test.each([
		["that does not exist", "00000000-0000-4000-8000-0000000000ff"],
		["whose id is no UUID", "accounts"],
	])("is told workspace_not_found for a workspace %s", async (_case, id) => {
		const harness = await startLedger();

		const called = await harness.call({
			actor: ALICE,
			workspace: id,
			operation: "ledger.listEntries",
			input: {},
		});

		expect(called).toEqual({
			ok: false,
			failure: {
				code: "workspace_not_found",
				kind: "not_found",
				detail: "the workspace does not exist",
				issues: [],
			},
		});
	});
});

describe("the operation harness", () => {
	test("gives the use case a fixed clock, sequential ids and a fixed random number by default", async () => {
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

	test("gives the use case the clock, ids and random numbers a test passes", async () => {
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
