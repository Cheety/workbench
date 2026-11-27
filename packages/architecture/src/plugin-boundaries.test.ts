import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPluginBoundaryViolations } from "./plugin-boundaries.ts";

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
	"plugin-notes/src/plugin.ts": 'import { store } from "./store.ts";',
	"plugin-notes/src/store.ts": "export const store = new Map();",
	"plugin-notes/src/contract/index.ts": "export type Note = { id: string };",
};

const STORE = "@fixture/plugin-notes/src/store.ts";

const BOARD_PACKAGE_JSON = JSON.stringify({
	name: "@fixture/plugin-board",
	workbench: { plugin: { name: "board", entry: "./src/plugin.ts" } },
});

async function packagesDirectoryWith(
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "workbench-architecture-"));
	temporaryDirectories.push(directory);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(directory, path)), { recursive: true });
		await writeFile(join(directory, path), content);
	}
	return directory;
}

function boardPluginImporting(source: string): Record<string, string> {
	return {
		...NOTES_PLUGIN,
		"plugin-board/package.json": BOARD_PACKAGE_JSON,
		"plugin-board/src/plugin.ts": source,
	};
}

describe("imports between plugins", () => {
	test("rejects an import from the inside of a foreign plugin", async () => {
		const packages = await packagesDirectoryWith(
			boardPluginImporting(
				'import { store } from "@fixture/plugin-notes/src/store.ts";',
			),
		);

		expect(await findPluginBoundaryViolations(packages)).toEqual([
			{
				rule: "foreign_plugin_internals",
				file: "plugin-board/src/plugin.ts",
				importPath: "@fixture/plugin-notes/src/store.ts",
			},
		]);
	});

	test.each([
		[`import type { Store } from "${STORE}";`, STORE],
		[`export type { Store } from "${STORE}";`, STORE],
		[`type Store = import("${STORE}").Store;`, STORE],
		[`const notes = await import("${STORE}");`, STORE],
		[`import "${STORE}";`, STORE],
		[`const notes = await import(/* lazy */ "${STORE}");`, STORE],
		[`const notes = await import(\n\t// lazy\n\t"${STORE}"\n);`, STORE],
		[`const path = require.resolve("${STORE}");`, STORE],
		[`const url = import.meta.resolve("${STORE}");`, STORE],
		[`mock.module("${STORE}", () => ({}));`, STORE],
		[`/// <reference types="${STORE}" />`, STORE],
		[
			'/// <reference path="../../plugin-notes/src/store.ts" />',
			"../../plugin-notes/src/store.ts",
		],
	])(
		"rejects every form of import from the inside of a foreign plugin: %s",
		async (source, importPath) => {
			const packages = await packagesDirectoryWith(
				boardPluginImporting(source),
			);

			expect(await findPluginBoundaryViolations(packages)).toEqual([
				{
					rule: "foreign_plugin_internals",
					file: "plugin-board/src/plugin.ts",
					importPath,
				},
			]);
		},
	);

	test("rejects the root of a foreign plugin package, which is not its contract", async () => {
		const packages = await packagesDirectoryWith(
			boardPluginImporting('import notes from "@fixture/plugin-notes";'),
		);

		expect(await findPluginBoundaryViolations(packages)).toEqual([
			{
				rule: "foreign_plugin_internals",
				file: "plugin-board/src/plugin.ts",
				importPath: "@fixture/plugin-notes",
			},
		]);
	});

	test.each([
		["../../plugin-notes/src/store.ts"],
		["../../plugin-notes/src/contract/index.ts"],
		["../../plugin-notes"],
		["../../plugin-notes/"],
		["../../node_modules/@fixture/plugin-notes/src/store.ts"],
		["../node_modules/@fixture/plugin-notes"],
		["/srv/workbench/node_modules/@fixture/plugin-notes/contract"],
	])("rejects a path import into a foreign plugin: %s", async (importPath) => {
		const packages = await packagesDirectoryWith(
			boardPluginImporting(`import { store } from "${importPath}";`),
		);

		expect(await findPluginBoundaryViolations(packages)).toEqual([
			{
				rule: "foreign_plugin_internals",
				file: "plugin-board/src/plugin.ts",
				importPath,
			},
		]);
	});

	test("allows an import from the contract export of a foreign plugin", async () => {
		const packages = await packagesDirectoryWith(
			boardPluginImporting(
				'import { Note } from "@fixture/plugin-notes/contract";',
			),
		);

		expect(await findPluginBoundaryViolations(packages)).toEqual([]);
	});

	test("ignores the installed dependencies of a plugin package", async () => {
		const packages = await packagesDirectoryWith({
			...boardPluginImporting(""),
			"plugin-board/node_modules/vendor/index.js":
				'import { store } from "@fixture/plugin-notes/src/store.ts";',
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([]);
	});
});

describe("the contract export of a plugin", () => {
	test.each([
		['import { store } from "../store.ts";', "../store.ts"],
		['import plugin from "../plugin.ts";', "../plugin.ts"],
		['/// <reference path="../store.ts" />', "../store.ts"],
		['import { notes } from "./notes.test.ts";', "./notes.test.ts"],
		[`import { store } from "${STORE}";`, STORE],
	])(
		"rejects any file of its own package outside the contract: %s",
		async (source, importPath) => {
			const packages = await packagesDirectoryWith({
				...NOTES_PLUGIN,
				"plugin-notes/src/contract/index.ts": source,
			});

			expect(await findPluginBoundaryViolations(packages)).toEqual([
				{
					rule: "contract_imports_plugin_code",
					file: "plugin-notes/src/contract/index.ts",
					importPath,
				},
			]);
		},
	);

	test("allows a contract that spans several files of its directory", async () => {
		const packages = await packagesDirectoryWith({
			...NOTES_PLUGIN,
			"plugin-notes/src/contract/index.ts": [
				'export type { Note } from "./note.ts";',
				'/// <reference path="events/note-created.ts" />',
			].join("\n"),
			"plugin-notes/src/contract/note.ts": [
				'import type { NoteId } from "./ids/note-id.ts";',
				"export type Note = { id: NoteId };",
			].join("\n"),
			"plugin-notes/src/contract/ids/note-id.ts":
				"export type NoteId = string;",
			"plugin-notes/src/contract/events/note-created.ts":
				'import type { NoteId } from "../ids/note-id.ts";',
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([]);
	});

	test("rejects plugin code that a further file of the contract imports", async () => {
		const packages = await packagesDirectoryWith({
			...NOTES_PLUGIN,
			"plugin-notes/src/contract/index.ts":
				'export type { Note } from "./note.ts";',
			"plugin-notes/src/contract/note.ts":
				'import { store } from "../store.ts";',
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([
			{
				rule: "contract_imports_plugin_code",
				file: "plugin-notes/src/contract/note.ts",
				importPath: "../store.ts",
			},
		]);
	});

	test("rejects a file in the directory of the contract that the contract does not reach", async () => {
		const packages = await packagesDirectoryWith({
			...NOTES_PLUGIN,
			"plugin-notes/src/contract/draft.ts": "export const draft = {};",
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([
			{
				rule: "contract_beside_other_code",
				file: "plugin-notes/src/contract/draft.ts",
			},
		]);
	});

	test("rejects client code that lies beside a contract outside the directory of the entry", async () => {
		const packages = await packagesDirectoryWith({
			"plugin-notes/package.json": JSON.stringify({
				name: "@fixture/plugin-notes",
				exports: { "./contract": "./src/contract.ts" },
				workbench: { plugin: { name: "notes", entry: "./server/plugin.ts" } },
			}),
			"plugin-notes/server/plugin.ts": "export default {};",
			"plugin-notes/src/client/ui.tsx": "export const Ui = () => null;",
			"plugin-notes/src/contract.ts": "export type Note = { id: string };",
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([
			{
				rule: "contract_beside_other_code",
				file: "plugin-notes/src/client/ui.tsx",
			},
		]);
	});

	test("rejects client code beside a contract that imports only part of it", async () => {
		const packages = await packagesDirectoryWith({
			"plugin-notes/package.json": JSON.stringify({
				name: "@fixture/plugin-notes",
				exports: { "./contract": "./src/contract.ts" },
				workbench: { plugin: { name: "notes", entry: "./server/plugin.ts" } },
			}),
			"plugin-notes/server/plugin.ts": "export default {};",
			"plugin-notes/src/client/app.tsx": 'import { Ui } from "./ui.tsx";',
			"plugin-notes/src/client/ui.tsx": "export const Ui = () => null;",
			"plugin-notes/src/contract.ts": 'import { Ui } from "./client/ui.tsx";',
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([
			{
				rule: "contract_beside_other_code",
				file: "plugin-notes/src/client/app.tsx",
			},
		]);
	});

	test("allows tests in the directory of the contract", async () => {
		const packages = await packagesDirectoryWith({
			...NOTES_PLUGIN,
			"plugin-notes/src/contract/index.test.ts": 'import "../store.ts";',
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([]);
	});

	test("allows other packages and the contracts of foreign plugins", async () => {
		const packages = await packagesDirectoryWith({
			...boardPluginImporting(""),
			"plugin-board/package.json": JSON.stringify({
				name: "@fixture/plugin-board",
				exports: { "./contract": "./src/contract/index.ts" },
				workbench: { plugin: { name: "board", entry: "./src/plugin.ts" } },
			}),
			"plugin-board/src/contract/index.ts": [
				'import type { Note } from "@fixture/plugin-notes/contract";',
				'import { z } from "zod";',
				'import type { PluginManifest } from "@workbench/sdk";',
				'export type { Board } from "@fixture/plugin-board/contract";',
			].join("\n"),
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([]);
	});

	test.each([
		["./src/contract.ts", "./src/plugin.ts"],
		["./src/index.ts", "./src/server/plugin.ts"],
	])(
		"rejects the contract %s in a directory that holds the entry %s",
		async (contract, entry) => {
			const packages = await packagesDirectoryWith({
				"plugin-notes/package.json": JSON.stringify({
					name: "@fixture/plugin-notes",
					exports: { "./contract": contract },
					workbench: { plugin: { name: "notes", entry } },
				}),
			});

			expect(await findPluginBoundaryViolations(packages)).toEqual([
				{ rule: "contract_beside_entry", file: "plugin-notes/package.json" },
			]);
		},
	);

	test("rejects a contract export that does not name one file", async () => {
		const packages = await packagesDirectoryWith({
			...NOTES_PLUGIN,
			"plugin-notes/package.json": JSON.stringify({
				name: "@fixture/plugin-notes",
				exports: { "./contract": { default: "./src/plugin.ts" } },
				workbench: { plugin: { name: "notes", entry: "./src/plugin.ts" } },
			}),
		});

		expect(await findPluginBoundaryViolations(packages)).toEqual([
			{ rule: "contract_export_not_a_path", file: "plugin-notes/package.json" },
		]);
	});
});

describe("the plugin packages of this repository", () => {
	test("import one another only through contracts that hold no plugin code", async () => {
		expect(
			await findPluginBoundaryViolations(join(import.meta.dir, "..", "..")),
		).toEqual([]);
	});
});
