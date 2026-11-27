import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type OperationHarness,
	pluginPackageAt,
	startOperationHarness,
} from "@workbench/core/testing";
import type { Actor } from "@workbench/sdk";

const ALICE: Actor = { kind: "user", id: "alice" };

let harness: OperationHarness | undefined;

afterEach(async () => {
	await harness?.stop();
	harness = undefined;
});

async function startReference(): Promise<OperationHarness> {
	harness = await startOperationHarness({
		plugins: [await pluginPackageAt(join(import.meta.dir, ".."))],
	});
	return harness;
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

		const note = {
			id: "00000000-0000-4000-8000-000000000002",
			title: "First thoughts",
			createdAt: "2026-11-26T08:00:00.000Z",
		};
		expect(created).toEqual({ ok: true, output: note });
		expect(listed).toEqual({ ok: true, output: { notes: [note] } });
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

	test("list the newest notes first, up to the limit", async () => {
		let minute = 0;
		harness = await startOperationHarness({
			plugins: [await pluginPackageAt(join(import.meta.dir, ".."))],
			now: () => new Date(Date.UTC(2026, 10, 26, 8, minute++)),
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
});
