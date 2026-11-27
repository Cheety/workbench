import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPluginImports } from "./plugin-imports.ts";

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

describe("plugin imports of the core", () => {
	test.each([
		["@fixture/plugin-notes"],
		["@fixture/plugin-notes/contract"],
		["@fixture/plugin-notes/src/plugin.ts"],
		["../../plugin-notes/src/plugin.ts"],
		["../../plugin-notes"],
		["../../node_modules/@fixture/plugin-notes/contract"],
		["/srv/workbench/node_modules/@fixture/plugin-notes"],
	])("are found for %s", async (importPath) => {
		const packages = await packagesDirectoryWith({
			"core/src/kernel.ts": `import type { Note } from "${importPath}";`,
		});

		expect(await findPluginImports(join(packages, "core"), packages)).toEqual([
			{ file: "src/kernel.ts", importPath },
		]);
	});

	test("are not found for packages that are no plugin and for files of the core", async () => {
		const packages = await packagesDirectoryWith({
			"sdk/package.json": JSON.stringify({ name: "@fixture/sdk" }),
			"core/src/kernel.ts": [
				'import { definePlugin } from "@fixture/sdk";',
				'import { z } from "zod";',
				'import { loadConfig } from "./config.ts";',
				'import type { Manifest } from "../../sdk/src/index.ts";',
			].join("\n"),
		});

		expect(await findPluginImports(join(packages, "core"), packages)).toEqual(
			[],
		);
	});

	test("are not looked for in tests, whose fixture plugins may be real plugin packages", async () => {
		const packages = await packagesDirectoryWith({
			"core/src/kernel.test.ts": 'import notes from "@fixture/plugin-notes";',
		});

		expect(await findPluginImports(join(packages, "core"), packages)).toEqual(
			[],
		);
	});

	test("are not looked for in installed dependencies", async () => {
		const packages = await packagesDirectoryWith({
			"core/node_modules/vendor/index.js":
				'import notes from "@fixture/plugin-notes";',
		});

		expect(await findPluginImports(join(packages, "core"), packages)).toEqual(
			[],
		);
	});
});

describe("the packages of this repository", () => {
	const packages = join(import.meta.dir, "..", "..");

	test.each([["core"], ["sdk"]])(
		"%s imports no plugin package, which the kernel finds at runtime",
		async (packageDirectory) => {
			expect(
				await findPluginImports(join(packages, packageDirectory), packages),
			).toEqual([]);
		},
	);
});
