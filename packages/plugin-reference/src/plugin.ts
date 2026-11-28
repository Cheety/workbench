import { DATABASE_CAPABILITY, definePlugin } from "@workbench/sdk";
import { noteCreated } from "./contract/index.ts";
import {
	createNote,
	listNotes,
	noteCreate,
	noteEdit,
	noteRead,
	renameNote,
} from "./notes.ts";

export default definePlugin({
	manifest: { name: "reference", capabilities: [DATABASE_CAPABILITY] },
	rights: [noteCreate, noteRead, noteEdit],
	operations: [createNote, listNotes, renameNote],
	events: [noteCreated],
});
