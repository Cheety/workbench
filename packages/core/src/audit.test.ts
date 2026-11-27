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

type SettableClock = {
	now(): Date;
	set(time: string): void;
};

function clockAt(start: string): SettableClock {
	let current = new Date(start);
	return {
		now: () => current,
		set: (time) => {
			current = new Date(time);
		},
	};
}

type AuditPage = {
	readonly limit: number;
	readonly cursor: string | null;
};

const FIRST_TEN: AuditPage = { limit: 10, cursor: null };

function listAuditEntries(
	harness: OperationHarness,
	workspace: string,
	page: AuditPage,
): Promise<OperationResult> {
	return harness.call({
		actor: AUDITOR,
		workspace,
		operation: "core.listAuditEntries",
		input: page,
	});
}

const auditPage = z.object({
	entries: z.array(z.object({ id: z.string(), occurredAt: z.string() })),
	nextCursor: z.string().nullable(),
});

function pageOf(result: OperationResult): z.infer<typeof auditPage> {
	if (!result.ok) throw new Error("the audit could not be listed");
	return auditPage.parse(result.output);
}

async function addEntries(
	harness: OperationHarness,
	workspace: string,
	count: number,
): Promise<void> {
	for (let amount = 1; amount <= count; amount++)
		await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount },
		});
}

function cursorOf(position: unknown): string {
	return Buffer.from(JSON.stringify(position)).toString("base64url");
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

		const listed = await listAuditEntries(harness, workspace, FIRST_TEN);

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
				nextCursor: null,
			},
		});
	});

	test("holds one entry for each mutation that succeeded, the newest first", async () => {
		const clock = clockAt("2026-11-27T08:00:00.000Z");
		const harness = await startLedger({ now: clock.now });
		const workspace = await harness.createWorkspace("Accounts");
		clock.set("2026-11-27T08:01:00.000Z");
		await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: 42 },
		});
		clock.set("2026-11-27T08:02:00.000Z");
		await harness.call({
			actor: { kind: "service_account", id: "agent" },
			workspace,
			operation: "bell.ringBell",
			input: {},
		});

		const listed = await listAuditEntries(harness, workspace, FIRST_TEN);

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
				nextCursor: null,
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
		await listAuditEntries(harness, workspace, FIRST_TEN);

		const listed = await listAuditEntries(harness, workspace, FIRST_TEN);

		expect(listed).toEqual({
			ok: true,
			output: { entries: [], nextCursor: null },
		});
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

		const listed = await listAuditEntries(harness, workspace, FIRST_TEN);

		expect(called.ok).toBe(false);
		expect(listed).toEqual({
			ok: true,
			output: { entries: [], nextCursor: null },
		});
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

		const listed = await listAuditEntries(harness, archive, FIRST_TEN);

		expect(listed).toEqual({
			ok: true,
			output: { entries: [], nextCursor: null },
		});
	});
});

describe("a page of the audit", () => {
	test("holds at most the limit and continues after the cursor of the page before", async () => {
		const clock = clockAt("2026-11-27T08:00:00.000Z");
		const harness = await startLedger({ now: clock.now });
		const workspace = await harness.createWorkspace("Accounts");
		clock.set("2026-11-27T08:01:00.000Z");
		await addEntries(harness, workspace, 1);
		clock.set("2026-11-27T08:02:00.000Z");
		await addEntries(harness, workspace, 1);
		clock.set("2026-11-27T08:03:00.000Z");
		await addEntries(harness, workspace, 1);

		const first = pageOf(
			await listAuditEntries(harness, workspace, { limit: 2, cursor: null }),
		);
		const second = pageOf(
			await listAuditEntries(harness, workspace, {
				limit: 2,
				cursor: first.nextCursor,
			}),
		);

		expect(first.entries.map((listed) => listed.occurredAt)).toEqual([
			"2026-11-27T08:03:00.000Z",
			"2026-11-27T08:02:00.000Z",
		]);
		expect(first.nextCursor).toEqual(expect.any(String));
		expect(second).toEqual({
			entries: [
				expect.objectContaining({ occurredAt: "2026-11-27T08:01:00.000Z" }),
			],
			nextCursor: null,
		});
	});

	test("names no next cursor when it holds the last entries exactly up to the limit", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");
		await addEntries(harness, workspace, 2);

		const page = pageOf(
			await listAuditEntries(harness, workspace, { limit: 2, cursor: null }),
		);

		expect(page.entries).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
	});

	test("neither repeats nor skips an entry among entries of the same time", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");
		await addEntries(harness, workspace, 3);

		const first = pageOf(
			await listAuditEntries(harness, workspace, { limit: 1, cursor: null }),
		);
		const second = pageOf(
			await listAuditEntries(harness, workspace, {
				limit: 1,
				cursor: first.nextCursor,
			}),
		);
		const third = pageOf(
			await listAuditEntries(harness, workspace, {
				limit: 1,
				cursor: second.nextCursor,
			}),
		);

		expect(
			[first, second, third].map((page) =>
				page.entries.map((listed) => listed.id),
			),
		).toEqual([
			["00000000-0000-4000-a000-000000000003"],
			["00000000-0000-4000-a000-000000000002"],
			["00000000-0000-4000-a000-000000000001"],
		]);
		expect(third.nextCursor).toBeNull();
	});

	test.each([
		["that is no encoded position", "not a cursor"],
		["that encodes something else than a position", cursorOf({ page: 2 })],
		[
			"whose time is no time",
			cursorOf(["yesterday", "00000000-0000-4000-a000-000000000001"]),
		],
		["whose id is no UUID", cursorOf(["2026-11-27T08:00:00.000Z", "first"])],
	])("is refused for a cursor %s", async (_case, cursor) => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const listed = await listAuditEntries(harness, workspace, {
			limit: 10,
			cursor,
		});

		expect(listed).toEqual({
			ok: false,
			failure: {
				code: "core.invalid_cursor",
				kind: "rejected",
				detail: "the cursor is not one that a page of the audit named",
				issues: [],
			},
		});
	});

	test.each([
		["a limit of 0", { limit: 0, cursor: null }],
		["a limit over 100", { limit: 101, cursor: null }],
		["no cursor at all", { limit: 10 }],
	])("is refused as invalid input for %s", async (_case, input) => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts");

		const listed = await harness.call({
			actor: AUDITOR,
			workspace,
			operation: "core.listAuditEntries",
			input,
		});

		expect(listed).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "invalid_input" }),
		});
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
