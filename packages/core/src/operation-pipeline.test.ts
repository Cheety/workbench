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

const CLIENT_METHODS = [
	"unsafe",
	"begin",
	"savepoint",
	"commit",
	"rollback",
	"reserve",
	"file",
	"close",
] as const;

const STATEMENT_METHODS = ["cancel", "simple", "raw", "values"] as const;

const probeClient = defineOperation({
	...listEntries,
	name: "probeClient",
	output: z.object({
		clientMethods: z.array(z.string()),
		statementMethods: z.array(z.string()),
	}),
	execute: async (_input, ctx) => {
		const statement = ctx.sql`SELECT 1`;
		await statement;
		return {
			clientMethods: CLIENT_METHODS.filter(
				(method) => typeof Reflect.get(ctx.sql, method) === "function",
			),
			statementMethods: STATEMENT_METHODS.filter(
				(method) => typeof Reflect.get(statement, method) === "function",
			),
		};
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
			auditEntries,
			probeClient,
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

function outputOf(result: OperationResult): z.infer<typeof entry> {
	if (!result.ok) throw new Error("the operation failed");
	return entry.parse(result.output);
}

describe("an actor calling an operation", () => {
	test("reads with a query what a mutation wrote", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const added = await harness.call({
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
				entries: [{ id: outputOf(added).id, amount: 42 }],
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
			output: { id: expect.any(String), amount: 7 },
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
				issues: [{ path: ["amount"], message: expect.any(String) }],
			},
		});
	});

	test("finds nothing written by a mutation whose execute rejected the call", async () => {
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

	test("is told internal_error without internals when execute throws unexpectedly, and the log has the details", async () => {
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
				reason: "execute_threw",
				error: expect.objectContaining({
					name: "Error",
					message: "negative amount at /srv/ledger/entries",
				}),
			}),
		);
	});

	test("is told internal_error when the pipeline fails outside execute, and the log tells it apart from a throwing execute", async () => {
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

	test("is told internal_error and finds nothing written when execute returns an output the schema rejects", async () => {
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
				reason: "execute_threw",
			}),
		);
	});

	test("hands execute no method of the database client beyond a statement as tagged template", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const probed = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.probeClient",
			input: {},
		});

		expect(probed).toEqual({
			ok: true,
			output: { clientMethods: [], statementMethods: [] },
		});
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
