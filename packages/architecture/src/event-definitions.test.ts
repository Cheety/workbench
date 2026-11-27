import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findEventDefinitions } from "./event-definitions.ts";

const temporaryDirectories: string[] = [];

afterAll(async () => {
	await Promise.all(
		temporaryDirectories.map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

const NOTES_PLUGIN = {
	"plugin-notes/package.json": JSON.stringify({
		name: "@fixture/plugin-notes",
		exports: { "./contract": "./src/contract/index.ts" },
		workbench: { plugin: { name: "notes", entry: "./src/plugin.ts" } },
	}),
	"plugin-notes/src/plugin.ts": "export default {};",
	"plugin-notes/src/contract/index.ts": "export type Note = { id: string };",
};

const NOTE_CREATED = [
	'import { defineEvent } from "@fixture/sdk";',
	'export const noteCreated = defineEvent({ plugin: "notes", name: "NoteCreated" });',
].join("\n");

async function packagesDirectoryWith(
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "workbench-architecture-"));
	temporaryDirectories.push(directory);
	for (const [path, content] of Object.entries({ ...NOTES_PLUGIN, ...files })) {
		await mkdir(dirname(join(directory, path)), { recursive: true });
		await writeFile(join(directory, path), content);
	}
	return directory;
}

describe("event definitions of a plugin package", () => {
	test("are found in the contract, where a subscribing plugin can import them", async () => {
		const packages = await packagesDirectoryWith({
			"plugin-notes/src/contract/events.ts": NOTE_CREATED,
			"plugin-notes/src/contract/index.ts":
				'export { noteCreated } from "./events.ts";',
		});

		expect(await findEventDefinitions(packages)).toEqual({
			inContract: ["plugin-notes/src/contract/events.ts"],
			outsideContract: [],
		});
	});

	test("are found outside the contract, where no other plugin may import them", async () => {
		const packages = await packagesDirectoryWith({
			"plugin-notes/src/events.ts": NOTE_CREATED,
		});

		expect(await findEventDefinitions(packages)).toEqual({
			inContract: [],
			outsideContract: ["plugin-notes/src/events.ts"],
		});
	});

	test.each([
		[
			'import { defineEvent as event } from "@fixture/sdk";\nexport const noteCreated = event({});',
		],
		[
			'import * as sdk from "@fixture/sdk";\nexport const noteCreated = sdk.defineEvent({});',
		],
		['export { defineEvent } from "@fixture/sdk";'],
		[
			'const { defineEvent } = await import("@fixture/sdk");\nexport const noteCreated = defineEvent\n\t({});',
		],
	])(
		"are found outside the contract under every name defineEvent is reached by: %s",
		async (source) => {
			const packages = await packagesDirectoryWith({
				"plugin-notes/src/plugin.ts": source,
			});

			expect(await findEventDefinitions(packages)).toEqual({
				inContract: [],
				outsideContract: ["plugin-notes/src/plugin.ts"],
			});
		},
	);

	test("are outside the contract everywhere in a plugin package that publishes no contract", async () => {
		const packages = await packagesDirectoryWith({
			"plugin-board/package.json": JSON.stringify({
				name: "@fixture/plugin-board",
				workbench: { plugin: { name: "board", entry: "./src/plugin.ts" } },
			}),
			"plugin-board/src/contract/index.ts": NOTE_CREATED,
		});

		expect(await findEventDefinitions(packages)).toEqual({
			inContract: [],
			outsideContract: ["plugin-board/src/contract/index.ts"],
		});
	});

	test("are not found where a plugin subscribes to an event or names one", async () => {
		const packages = await packagesDirectoryWith({
			"plugin-notes/src/plugin.ts": [
				'import { defineEventSubscription, definePlugin } from "@fixture/sdk";',
				"export const defineEvents = [defineEventSubscription({})];",
				"export const redefineEvent = definePlugin({});",
			].join("\n"),
		});

		expect(await findEventDefinitions(packages)).toEqual({
			inContract: [],
			outsideContract: [],
		});
	});

	test("are not looked for in tests, whose fixture plugins define events of their own", async () => {
		const packages = await packagesDirectoryWith({
			"plugin-notes/src/plugin.test.ts": NOTE_CREATED,
			"plugin-notes/src/contract/index.test.ts": NOTE_CREATED,
		});

		expect(await findEventDefinitions(packages)).toEqual({
			inContract: [],
			outsideContract: [],
		});
	});

	test("are not looked for in installed dependencies", async () => {
		const packages = await packagesDirectoryWith({
			"plugin-notes/node_modules/@fixture/sdk/index.js": NOTE_CREATED,
		});

		expect(await findEventDefinitions(packages)).toEqual({
			inContract: [],
			outsideContract: [],
		});
	});

	test("are not looked for in packages that are no plugin, such as the SDK that declares defineEvent", async () => {
		const packages = await packagesDirectoryWith({
			"sdk/package.json": JSON.stringify({ name: "@fixture/sdk" }),
			"sdk/src/event.ts": "export function defineEvent(definition) {}",
		});

		expect(await findEventDefinitions(packages)).toEqual({
			inContract: [],
			outsideContract: [],
		});
	});
});

describe("the plugin packages of this repository", () => {
	const packages = join(import.meta.dir, "..", "..");

	test("include the reference plugin, whose event definition is found in its contract", async () => {
		const { inContract } = await findEventDefinitions(packages);

		expect(inContract).toContain("plugin-reference/src/contract/index.ts");
	});

	test("define events only in their contracts", async () => {
		const { outsideContract } = await findEventDefinitions(packages);

		expect(outsideContract).toEqual([]);
	});
});
