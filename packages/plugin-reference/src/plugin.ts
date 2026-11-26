import { DATABASE_CAPABILITY, definePlugin } from "@workbench/sdk";

export default definePlugin({
	manifest: { name: "reference", capabilities: [DATABASE_CAPABILITY] },
});
