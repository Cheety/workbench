import {
	type AccessedObject,
	defineOperation,
	defineRight,
} from "@workbench/sdk";
import { z } from "zod";
import { type Note, noteCreated } from "./contract/index.ts";

const MAX_TITLE_LENGTH = 200;

const MAX_LISTED_NOTES = 100;

const noteTitle = z.string().trim().min(1).max(MAX_TITLE_LENGTH);

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

export const noteCreate = defineRight({
	name: "reference.note.create",
	defaultRoles: ["owner", "editor"],
});

export const noteRead = defineRight({
	name: "reference.note.read",
	defaultRoles: ["owner", "editor", "viewer"],
});

export const noteEdit = defineRight({
	name: "reference.note.edit",
	defaultRoles: ["owner", "editor"],
});

export const createNote = defineOperation({
	name: "createNote",
	kind: "mutation",
	target: "workspace",
	right: noteCreate.name,
	input: z.object({ title: noteTitle }),
	output: note,
	execute: async ({ title }, ctx) => {
		const [row] = await ctx.sql`
			INSERT INTO notes (id, workspace_id, title, created_at, owner_kind, owner_id)
			VALUES (${ctx.newId()}, ${ctx.workspace}, ${title}, ${ctx.now()}, ${ctx.actor.kind}, ${ctx.actor.id})
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
	right: noteRead.name,
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

const accessedNoteRow = z.object({
	workspace_id: z.string(),
	owner_kind: z.enum(["user", "service_account"]).nullable(),
	owner_id: z.string().nullable(),
});

function accessedNoteOf(row: z.infer<typeof accessedNoteRow>): AccessedObject {
	return {
		workspace: row.workspace_id,
		owner:
			row.owner_kind === null || row.owner_id === null
				? null
				: { kind: row.owner_kind, id: row.owner_id },
	};
}

export const renameNote = defineOperation({
	name: "renameNote",
	kind: "mutation",
	target: "object",
	right: noteEdit.name,
	input: z.object({ noteId: z.guid(), title: noteTitle }),
	output: note,
	execute: async ({ noteId, title }, ctx) => {
		const [found] = await ctx.sql`
			SELECT workspace_id, owner_kind, owner_id FROM notes
			WHERE id = ${noteId}
			FOR UPDATE`;
		ctx.auth.requireAccess(
			found === undefined
				? undefined
				: accessedNoteOf(accessedNoteRow.parse(found)),
		);
		const [row] = await ctx.sql`
			UPDATE notes SET title = ${title}
			WHERE id = ${noteId}
			RETURNING id, title, created_at`;
		return noteOf(noteRow.parse(row));
	},
});
