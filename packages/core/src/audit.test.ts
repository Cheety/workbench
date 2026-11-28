import { afterEach, describe, expect, test } from "bun:test";
import {
	type Actor,
	DATABASE_CAPABILITY,
	defineOperation,
	definePlugin,
	defineRight,
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

const AGENT: Actor = { kind: "service_account", id: "agent" };

const VIEWER: Actor = { kind: "user", id: "viewer" };

const STRANGER: Actor = { kind: "user", id: "stranger" };

const MEMBERS = [
	{ actor: ALICE, role: "editor" },
	{ actor: AUDITOR, role: "owner" },
	{ actor: AGENT, role: "editor" },
	{ actor: VIEWER, role: "viewer" },
] as const;

const entryAdd = defineRight({
	name: "ledger.entry.add",
	defaultRoles: ["owner", "editor"],
});

const entryRead = defineRight({
	name: "ledger.entry.read",
	defaultRoles: ["owner", "editor", "viewer"],
});

const entry = z.object({ id: z.string(), amount: z.number().int() });

const addEntry = defineOperation({
	name: "addEntry",
	kind: "mutation",
	target: "workspace",
	right: entryAdd.name,
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
	right: entryRead.name,
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
		rights: [entryAdd, entryRead],
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
		definePlugin({
			manifest: { name: "bell" },
			rights: [{ name: "bell.bell.ring", defaultRoles: ["owner", "editor"] }],
			operations: [ringBell],
		}),
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

function issuing(...ids: readonly string[]): () => string {
	const remaining = ids.values();
	return () => {
		const next = remaining.next();
		if (next.done) throw new Error("no id left to issue");
		return next.value;
	};
}

const LOWEST_ID = "00000000-0000-4000-a000-000000000001";

const MIDDLE_ID = "00000000-0000-4000-a000-000000000005";

const HIGHEST_ID = "00000000-0000-4000-a000-000000000009";

const encodedPosition = z.tuple([z.iso.datetime(), z.guid()]);

type EncodedPosition = z.infer<typeof encodedPosition>;

function encoded(content: unknown): string {
	return Buffer.from(JSON.stringify(content)).toString("base64url");
}

function reencoded(
	cursor: string,
	change: (position: EncodedPosition) => unknown,
): string {
	const position = encodedPosition.parse(
		JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
	);
	if (encoded(position) !== cursor)
		throw new Error("the cursor is no longer base64url JSON of [time, id]");
	return encoded(change(position));
}

async function nextCursorOf(
	harness: OperationHarness,
	workspace: string,
): Promise<string> {
	await addEntries(harness, workspace, 2);
	const page = pageOf(
		await listAuditEntries(harness, workspace, { limit: 1, cursor: null }),
	);
	if (page.nextCursor === null) throw new Error("the page names no cursor");
	return page.nextCursor;
}

describe("the audit of a workspace", () => {
	test("names actor, operation, workspace and time in UTC of a mutation that succeeded", async () => {
		const harness = await startLedger({
			now: () => new Date("2026-11-27T09:30:00.000+01:00"),
		});
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
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

	test("holds one entry for each mutation that succeeded, the newest first, whatever order their ids have", async () => {
		const clock = clockAt("2026-11-27T08:00:00.000Z");
		const harness = await startLedger({
			now: clock.now,
			newAuditEntryId: issuing(HIGHEST_ID, LOWEST_ID),
		});
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		clock.set("2026-11-27T08:01:00.000Z");
		await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: 42 },
		});
		clock.set("2026-11-27T08:02:00.000Z");
		await harness.call({
			actor: AGENT,
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
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
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
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
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

	test.each([
		[
			"a mutation the role of the actor does not grant",
			VIEWER,
			"ledger.addEntry",
			{ amount: 42 },
		],
		[
			"a query of an actor without membership",
			STRANGER,
			"ledger.listEntries",
			{},
		],
	])("names %s as denied", async (_case, actor, operation, input) => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		await harness.call({ actor, workspace, operation, input });

		const listed = await listAuditEntries(harness, workspace, FIRST_TEN);

		expect(listed).toEqual({
			ok: true,
			output: {
				entries: [
					{
						id: expect.any(String),
						occurredAt: "2026-11-26T08:00:00.000Z",
						actor,
						apiTokenId: null,
						operation,
						workspace,
						result: "denied",
					},
				],
				nextCursor: null,
			},
		});
	});

	test("is closed to a member whose role is not owner", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);

		const listed = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.listAuditEntries",
			input: FIRST_TEN,
		});

		expect(listed).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "missing_right" }),
		});
	});

	test("holds only the entries of the workspace it is asked for", async () => {
		const harness = await startLedger();
		const accounts = await harness.createWorkspace("Accounts", MEMBERS);
		const archive = await harness.createWorkspace("Archive", MEMBERS);
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
	test("holds at most the limit and continues after the cursor of the page before, whatever order the ids have", async () => {
		const clock = clockAt("2026-11-27T08:00:00.000Z");
		const harness = await startLedger({
			now: clock.now,
			newAuditEntryId: issuing(HIGHEST_ID, LOWEST_ID, MIDDLE_ID),
		});
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
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

	test("continues after its cursor when a newer entry was written since the page before, whatever order the ids have", async () => {
		const clock = clockAt("2026-11-27T08:00:00.000Z");
		const harness = await startLedger({
			now: clock.now,
			newAuditEntryId: issuing(MIDDLE_ID, HIGHEST_ID, LOWEST_ID),
		});
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		clock.set("2026-11-27T08:01:00.000Z");
		await addEntries(harness, workspace, 1);
		clock.set("2026-11-27T08:02:00.000Z");
		await addEntries(harness, workspace, 1);
		const first = pageOf(
			await listAuditEntries(harness, workspace, { limit: 1, cursor: null }),
		);
		clock.set("2026-11-27T08:03:00.000Z");
		await addEntries(harness, workspace, 1);

		const second = pageOf(
			await listAuditEntries(harness, workspace, {
				limit: 1,
				cursor: first.nextCursor,
			}),
		);

		expect(first.entries.map((listed) => listed.occurredAt)).toEqual([
			"2026-11-27T08:02:00.000Z",
		]);
		expect(second).toEqual({
			entries: [
				expect.objectContaining({ occurredAt: "2026-11-27T08:01:00.000Z" }),
			],
			nextCursor: null,
		});
	});

	test("names no next cursor when it holds the last entries exactly up to the limit", async () => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		await addEntries(harness, workspace, 2);

		const page = pageOf(
			await listAuditEntries(harness, workspace, { limit: 2, cursor: null }),
		);

		expect(page.entries).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
	});

	test("orders entries of the same time by their id, so that none is repeated or skipped", async () => {
		const harness = await startLedger({
			newAuditEntryId: issuing(MIDDLE_ID, HIGHEST_ID, LOWEST_ID),
		});
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
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
		).toEqual([[HIGHEST_ID], [MIDDLE_ID], [LOWEST_ID]]);
		expect(third.nextCursor).toBeNull();
	});

	test.each<[string, (cursor: string) => string]>([
		["that is no encoded position", () => "not a cursor"],
		[
			"that encodes something else than a position",
			(cursor) => reencoded(cursor, () => ({ page: 2 })),
		],
		[
			"whose time is no time",
			(cursor) => reencoded(cursor, ([, id]) => ["yesterday", id]),
		],
		[
			"whose id is no UUID",
			(cursor) => reencoded(cursor, ([time]) => [time, "first"]),
		],
		["that carries more than its position", (cursor) => `${cursor}~~`],
	])("is refused for a cursor %s", async (_case, tamper) => {
		const harness = await startLedger();
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);
		const cursor = tamper(await nextCursorOf(harness, workspace));

		const listed = await listAuditEntries(harness, workspace, {
			limit: 10,
			cursor,
		});

		expect(listed).toEqual({
			ok: false,
			failure: {
				code: "core.invalid_cursor",
				kind: "rejected",
				detail: "the cursor does not name a position in the audit",
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
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);

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

const auditRefusal: PluginPackage = {
	packageName: "@workbench/plugin-refusal",
	pluginName: "refusal",
	version: "1.0.0",
	loadDefinition: async () =>
		definePlugin({
			manifest: { name: "refusal", capabilities: [DATABASE_CAPABILITY] },
		}),
	loadMigrations: async () => [
		{
			name: "0001_refuse_audit_entries.sql",
			sql: `CREATE FUNCTION refuse_audit_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit entries are refused'; END $$;
CREATE TRIGGER refuse_audit_entry BEFORE INSERT ON core.audit_entries FOR EACH ROW EXECUTE FUNCTION refuse_audit_entry();`,
		},
	],
};

describe("a mutation whose audit entry cannot be written", () => {
	test("is rolled back and fails as an internal error", async () => {
		const harness = await startOperationHarness({
			plugins: [ledger, auditRefusal],
		});
		harnesses.push(harness);
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);

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
		const audited = await listAuditEntries(harness, workspace, FIRST_TEN);

		expect(added).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
		expect(listed).toEqual({ ok: true, output: { entries: [] } });
		expect(pageOf(audited)).toEqual({ entries: [], nextCursor: null });
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

describe("a denied call whose audit entry cannot be written", () => {
	test("fails as an internal error instead of going unrecorded", async () => {
		const harness = await startOperationHarness({
			plugins: [ledger, auditRefusal],
		});
		harnesses.push(harness);
		const workspace = await harness.createWorkspace("Accounts", MEMBERS);

		const added = await harness.call({
			actor: VIEWER,
			workspace,
			operation: "ledger.addEntry",
			input: { amount: 42 },
		});

		expect(added).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
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
