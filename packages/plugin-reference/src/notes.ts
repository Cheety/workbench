import { defineOperation } from "@workbench/sdk";
import { z } from "zod";
import { type Note, noteCreated } from "./contract/index.ts";

const MAX_TITLE_LENGTH = 200;

const MAX_LISTED_NOTES = 100;

const note = z.object({
	id: z.string(),
	title: z.string(),
	createdAt: z.string(),
}) satisfies z.ZodType<Note>;

const noteRow = z.object({
	id: z.string(),
	title: z.string(),
	created_at: z.date(),
});

function noteOf(row: z.infer<typeof noteRow>): Note {
	return {
		id: row.id,
		title: row.title,
		createdAt: row.created_at.toISOString(),
	};
}

export const createNote = defineOperation({
	name: "createNote",
	kind: "mutation",
	target: "workspace",
	right: "reference.note.create",
	input: z.object({ title: z.string().trim().min(1).max(MAX_TITLE_LENGTH) }),
	output: note,
	execute: async ({ title }, ctx) => {
		const [row] = await ctx.sql`
			INSERT INTO notes (id, workspace_id, title, created_at)
			VALUES (${ctx.newId()}, ${ctx.workspace}, ${title}, ${ctx.now()})
			RETURNING id, title, created_at`;
		const created = noteOf(noteRow.parse(row));
		await ctx.publish(noteCreated, { noteId: created.id });
		return created;
	},
});

export const listNotes = defineOperation({
	name: "listNotes",
	kind: "query",
	target: "workspace",
	right: "reference.note.read",
	input: z.object({ limit: z.number().int().min(1).max(MAX_LISTED_NOTES) }),
	output: z.object({ notes: z.array(note) }),
	execute: async ({ limit }, ctx) => {
		const rows = await ctx.sql`
			SELECT id, title, created_at FROM notes
			WHERE workspace_id = ${ctx.workspace}
			ORDER BY created_at DESC, id DESC
			LIMIT ${limit}`;
		return { notes: z.array(noteRow).parse(rows).map(noteOf) };
	},
});
