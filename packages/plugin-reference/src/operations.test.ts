import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type OperationHarness,
	type OperationResult,
	type PluginPackage,
	pluginPackageAt,
	startOperationHarness,
} from "@workbench/core/testing";
import {
	type Actor,
	defineEventSubscription,
	definePlugin,
	eventSubscriptionCapability,
	type PublishedEvent,
} from "@workbench/sdk";
import { z } from "zod";
import { noteCreated } from "./contract/index.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

const BOB: Actor = { kind: "user", id: "bob" };

let harness: OperationHarness | undefined;

afterEach(async () => {
	await harness?.stop();
	harness = undefined;
});

function issuing(...ids: readonly string[]): () => string {
	const remaining = ids.values();
	return () => {
		const next = remaining.next();
		if (next.done) throw new Error("no id left to issue");
		return next.value;
	};
}

async function startReference(
	...others: readonly PluginPackage[]
): Promise<OperationHarness> {
	harness = await startOperationHarness({
		plugins: [await pluginPackageAt(join(import.meta.dir, "..")), ...others],
	});
	return harness;
}

function noteIdOf(created: OperationResult): string {
	if (!created.ok) throw new Error("the note was not created");
	return z.object({ id: z.string() }).parse(created.output).id;
}

function searchIndexing(received: PublishedEvent<{ noteId: string }>[]) {
	return {
		packageName: "@workbench/plugin-search",
		pluginName: "search",
		version: "1.0.0",
		loadDefinition: async () =>
			definePlugin({
				manifest: {
					name: "search",
					capabilities: [eventSubscriptionCapability(noteCreated)],
				},
				subscriptions: [
					defineEventSubscription({
						event: noteCreated,
						handle: async (event) => {
							received.push(event);
						},
					}),
				],
			}),
	} satisfies PluginPackage;
}

describe("the notes of the reference plugin", () => {
	test("list a note that the mutation created", async () => {
		const reference = await startReference();
		const workspace = await reference.createWorkspace("Alpha", [
			{ actor: ALICE, role: "owner" },
		]);

		const created = await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.createNote",
			input: { title: "First thoughts" },
		});
		const listed = await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.listNotes",
			input: { limit: 10 },
		});

		expect(created).toEqual({
			ok: true,
			output: {
				id: expect.any(String),
				title: "First thoughts",
				createdAt: "2026-11-26T08:00:00.000Z",
			},
		});
		expect(listed).toEqual({
			ok: true,
			output: { notes: [created.ok ? created.output : undefined] },
		});
	});

	test("list only the notes of the workspace they were created in", async () => {
		const reference = await startReference();
		const alpha = await reference.createWorkspace("Alpha", [
			{ actor: ALICE, role: "owner" },
		]);
		const beta = await reference.createWorkspace("Beta", [
			{ actor: ALICE, role: "owner" },
		]);
		await reference.call({
			actor: ALICE,
			workspace: alpha,
			operation: "reference.createNote",
			input: { title: "Alpha only" },
		});

		const listed = await reference.call({
			actor: ALICE,
			workspace: beta,
			operation: "reference.listNotes",
			input: { limit: 10 },
		});

		expect(listed).toEqual({ ok: true, output: { notes: [] } });
	});

	test("list the newest notes first, up to the limit, whatever order their ids have", async () => {
		let minute = 0;
		harness = await startOperationHarness({
			plugins: [await pluginPackageAt(join(import.meta.dir, ".."))],
			now: () => new Date(Date.UTC(2026, 10, 26, 8, minute++)),
			newId: issuing(
				"00000000-0000-4000-8000-000000000001",
				"00000000-0000-4000-8000-000000000005",
				"00000000-0000-4000-8000-000000000009",
				"00000000-0000-4000-8000-000000000007",
			),
		});
		const workspace = await harness.createWorkspace("Alpha", [
			{ actor: ALICE, role: "owner" },
		]);
		for (const title of ["Oldest", "Middle", "Newest"])
			await harness.call({
				actor: ALICE,
				workspace,
				operation: "reference.createNote",
				input: { title },
			});

		const listed = await harness.call({
			actor: ALICE,
			workspace,
			operation: "reference.listNotes",
			input: { limit: 2 },
		});

		expect(listed).toEqual({
			ok: true,
			output: {
				notes: [
					expect.objectContaining({ title: "Newest" }),
					expect.objectContaining({ title: "Middle" }),
				],
			},
		});
	});

	test.each([
		["an empty title", "reference.createNote", { title: "" }],
		["a title of only spaces", "reference.createNote", { title: "   " }],
		[
			"a title over 200 characters",
			"reference.createNote",
			{ title: "x".repeat(201) },
		],
		["a limit over 100", "reference.listNotes", { limit: 101 }],
	])("reject %s as invalid input", async (_case, operation, input) => {
		const reference = await startReference();
		const workspace = await reference.createWorkspace("Alpha", [
			{ actor: ALICE, role: "owner" },
		]);

		const called = await reference.call({
			actor: ALICE,
			workspace,
			operation,
			input,
		});

		expect(called).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "invalid_input" }),
		});
	});

	test("tell a plugin that subscribed to NoteCreated which note the mutation created", async () => {
		const received: PublishedEvent<{ noteId: string }>[] = [];
		const reference = await startReference(searchIndexing(received));
		const workspace = await reference.createWorkspace("Alpha", [
			{ actor: ALICE, role: "owner" },
		]);

		const created = await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.createNote",
			input: { title: "First thoughts" },
		});
		await reference.deliverEvents();

		expect(received).toEqual([
			{
				id: expect.any(String),
				name: "reference.NoteCreated",
				version: 1,
				occurredAt: new Date("2026-11-26T08:00:00.000Z"),
				workspace,
				payload: { noteId: noteIdOf(created) },
			},
		]);
	});
});

describe("access to the notes of the reference plugin", () => {
	test("lets a viewer list the notes but not create one", async () => {
		const reference = await startReference();
		const workspace = await reference.createWorkspace("Alpha", [
			{ actor: BOB, role: "viewer" },
		]);

		const listed = await reference.call({
			actor: BOB,
			workspace,
			operation: "reference.listNotes",
			input: { limit: 10 },
		});
		const created = await reference.call({
			actor: BOB,
			workspace,
			operation: "reference.createNote",
			input: { title: "Not mine to write" },
		});

		expect(listed).toEqual({ ok: true, output: { notes: [] } });
		expect(created).toEqual({
			ok: false,
			failure: expect.objectContaining({
				code: "missing_right",
				kind: "forbidden",
			}),
		});
	});

	test.each([
		["reference.createNote", { title: "Somewhere" }],
		["reference.listNotes", { limit: 10 }],
	])(
		"answers %s by a non-member as if the workspace did not exist",
		async (operation, input) => {
			const reference = await startReference();
			const foreign = await reference.createWorkspace("Alpha", [
				{ actor: ALICE, role: "owner" },
			]);

			const onForeign = await reference.call({
				actor: BOB,
				workspace: foreign,
				operation,
				input,
			});
			const onMissing = await reference.call({
				actor: BOB,
				workspace: "00000000-0000-4000-8000-00000000ffff",
				operation,
				input,
			});

			expect(onForeign).toEqual({
				ok: false,
				failure: expect.objectContaining({ code: "workspace_not_found" }),
			});
			expect(onForeign).toEqual(onMissing);
		},
	);

	test("lets the actor who created a note rename it", async () => {
		const reference = await startReference();
		const workspace = await reference.createWorkspace("Alpha", [
			{ actor: ALICE, role: "editor" },
		]);
		const created = await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.createNote",
			input: { title: "Draft" },
		});

		const renamed = await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.renameNote",
			input: { noteId: noteIdOf(created), title: "Final" },
		});

		expect(renamed).toEqual({
			ok: true,
			output: {
				id: noteIdOf(created),
				title: "Final",
				createdAt: "2026-11-26T08:00:00.000Z",
			},
		});
	});

	test.each([
		["a viewer", "viewer", "missing_right"],
		["an editor who did not create it", "editor", "not_object_owner"],
	] as const)("refuses %s to rename a note", async (_case, role, code) => {
		const reference = await startReference();
		const workspace = await reference.createWorkspace("Alpha", [
			{ actor: ALICE, role: "owner" },
			{ actor: BOB, role },
		]);
		const created = await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.createNote",
			input: { title: "Alice's" },
		});

		const renamed = await reference.call({
			actor: BOB,
			workspace,
			operation: "reference.renameNote",
			input: { noteId: noteIdOf(created), title: "Bob's" },
		});
		const listed = await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.listNotes",
			input: { limit: 10 },
		});

		expect(renamed).toEqual({
			ok: false,
			failure: expect.objectContaining({ code, kind: "forbidden" }),
		});
		expect(listed).toEqual({
			ok: true,
			output: { notes: [expect.objectContaining({ title: "Alice's" })] },
		});
	});

	test("answers a note of another workspace as if it did not exist", async () => {
		const reference = await startReference();
		const alpha = await reference.createWorkspace("Alpha", [
			{ actor: ALICE, role: "owner" },
		]);
		const beta = await reference.createWorkspace("Beta", [
			{ actor: ALICE, role: "owner" },
		]);
		const created = await reference.call({
			actor: ALICE,
			workspace: alpha,
			operation: "reference.createNote",
			input: { title: "Alpha only" },
		});

		const fromBeta = await reference.call({
			actor: ALICE,
			workspace: beta,
			operation: "reference.renameNote",
			input: { noteId: noteIdOf(created), title: "Moved" },
		});
		const missing = await reference.call({
			actor: ALICE,
			workspace: beta,
			operation: "reference.renameNote",
			input: { noteId: "00000000-0000-4000-8000-00000000ffff", title: "Moved" },
		});

		expect(fromBeta).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "object_not_found" }),
		});
		expect(fromBeta).toEqual(missing);
	});

	test("records the refused renaming of a note of another actor in the audit", async () => {
		const reference = await startReference();
		const workspace = await reference.createWorkspace("Alpha", [
			{ actor: ALICE, role: "owner" },
			{ actor: BOB, role: "editor" },
		]);
		const created = await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.createNote",
			input: { title: "Alice's" },
		});
		await reference.call({
			actor: BOB,
			workspace,
			operation: "reference.renameNote",
			input: { noteId: noteIdOf(created), title: "Bob's" },
		});

		const audited = await reference.call({
			actor: ALICE,
			workspace,
			operation: "core.listAuditEntries",
			input: { limit: 10, cursor: null },
		});

		expect(audited).toEqual({
			ok: true,
			output: {
				entries: [
					expect.objectContaining({
						actor: BOB,
						operation: "reference.renameNote",
						result: "denied",
					}),
					expect.objectContaining({
						actor: ALICE,
						operation: "reference.createNote",
						result: "succeeded",
					}),
				],
				nextCursor: null,
			},
		});
	});
});
