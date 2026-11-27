import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type OperationHarness,
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
import { noteCreated } from "./contract/index.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

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
		const workspace = await reference.createWorkspace("Alpha");

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
		const alpha = await reference.createWorkspace("Alpha");
		const beta = await reference.createWorkspace("Beta");
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
		const workspace = await harness.createWorkspace("Alpha");
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
		const workspace = await reference.createWorkspace("Alpha");

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
		const workspace = await reference.createWorkspace("Alpha");

		await reference.call({
			actor: ALICE,
			workspace,
			operation: "reference.createNote",
			input: { title: "First thoughts" },
		});
		await reference.deliverEvents();

		expect(received).toEqual([
			{
				id: "00000000-0000-4000-e000-000000000001",
				name: "reference.NoteCreated",
				version: 1,
				occurredAt: new Date("2026-11-26T08:00:00.000Z"),
				workspace,
				payload: { noteId: "00000000-0000-4000-8000-000000000002" },
			},
		]);
	});
});
