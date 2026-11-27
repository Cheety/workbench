import { defineEvent } from "@workbench/sdk";
import { z } from "zod";

export type NoteId = string;

export type Note = {
	readonly id: NoteId;
	readonly title: string;
	readonly createdAt: string;
};

export const noteCreated = defineEvent({
	plugin: "reference",
	name: "NoteCreated",
	version: 1,
	payload: z.object({ noteId: z.string() }),
});
