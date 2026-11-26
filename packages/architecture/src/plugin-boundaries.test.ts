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
		['import type { Store } from "@fixture/plugin-notes/src/store.ts";'],
		['export type { Store } from "@fixture/plugin-notes/src/store.ts";'],
		['type Store = import("@fixture/plugin-notes/src/store.ts").Store;'],
		['const notes = await import("@fixture/plugin-notes/src/store.ts");'],
		['import "@fixture/plugin-notes/src/store.ts";'],
	])(
		"rejects every form of import from the inside of a foreign plugin: %s",
		async (source) => {
			const packages = await packagesDirectoryWith(
				boardPluginImporting(source),
			);

			expect(await findPluginBoundaryViolations(packages)).toEqual([
				{
					rule: "foreign_plugin_internals",
					file: "plugin-board/src/plugin.ts",
					importPath: "@fixture/plugin-notes/src/store.ts",
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
	])(
		"rejects a relative import into a foreign plugin: %s",
		async (importPath) => {
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
		},
	);

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
		["plugin-notes/src/contract/index.ts", "../store.ts"],
		["plugin-notes/src/contract/index.ts", "../plugin.ts"],
		["plugin-notes/src/contract/note.ts", "../store.ts"],
		[
			"plugin-notes/src/contract/index.ts",
			"@fixture/plugin-notes/src/store.ts",
		],
	])(
		"rejects code of its own plugin imported by %s from %s",
		async (file, importPath) => {
			const packages = await packagesDirectoryWith({
				...NOTES_PLUGIN,
				[file]: `import { store } from "${importPath}";`,
			});

			expect(await findPluginBoundaryViolations(packages)).toEqual([
				{ rule: "contract_imports_plugin_code", file, importPath },
			]);
		},
	);

	test("allows other files of the contract", async () => {
		const packages = await packagesDirectoryWith({
			...NOTES_PLUGIN,
			"plugin-notes/src/contract/index.ts":
				'export type { Note } from "./note.ts";',
			"plugin-notes/src/contract/note.ts": "export type Note = { id: string };",
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
