import { DATABASE_CAPABILITY, definePlugin } from "@workbench/sdk";
import { noteCreated } from "./contract/index.ts";
import { createNote, listNotes } from "./notes.ts";

export default definePlugin({
	manifest: { name: "reference", capabilities: [DATABASE_CAPABILITY] },
	operations: [createNote, listNotes],
	events: [noteCreated],
});
