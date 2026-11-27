import { DATABASE_CAPABILITY, definePlugin } from "@workbench/sdk";
import { createNote, listNotes } from "./notes.ts";

export default definePlugin({
	manifest: { name: "reference", capabilities: [DATABASE_CAPABILITY] },
	operations: [createNote, listNotes],
});
