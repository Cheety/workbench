import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPluginPackages } from "./plugin-discovery.ts";

let packagesDirectory: string;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "workbench-discovery-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeNotesPlugin(root: string, entry: string): Promise<void> {
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({
			name: "@fixture/plugin-notes",
			version: "1.2.3",
			workbench: { plugin: { name: "notes", entry } },
		}),
	);
	await writeFile(
		join(root, "src", "plugin.ts"),
		'export default { manifest: { name: "notes" } };',
	);
}

async function writePackage(
	directory: string,
	packageJson: Record<string, unknown>,
	entrySource?: string,
): Promise<void> {
	const root = join(packagesDirectory, directory);
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
	if (entrySource !== undefined)
		await writeFile(join(root, "src", "plugin.ts"), entrySource);
}

beforeAll(async () => {
	packagesDirectory = await mkdtemp(join(tmpdir(), "workbench-discovery-"));
	await writePackage(
		"plugin-notes",
		{
			name: "@fixture/plugin-notes",
			version: "1.2.3",
			workbench: { plugin: { name: "notes", entry: "./src/plugin.ts" } },
		},
		'export default { manifest: { name: "notes" } };',
	);
	await writePackage(
		"plugin-broken",
		{
			name: "@fixture/plugin-broken",
			version: "0.1.0",
			workbench: { plugin: { name: "broken", entry: "./src/plugin.ts" } },
		},
		'throw new TypeError("broken on import");',
	);
	await writePackage("library", {
		name: "@fixture/library",
		version: "3.0.0",
	});
	await writePackage("plugin-old-style", {
		name: "@fixture/plugin-old-style",
		version: "1.0.0",
		workbench: { plugin: "./src/plugin.ts" },
	});
	await writePackage("plugin-unnamed", {
		name: "@fixture/plugin-unnamed",
		version: "1.0.0",
		workbench: { plugin: { name: "Not A Name", entry: "./src/plugin.ts" } },
	});
	await mkdir(join(packagesDirectory, "plugin-garbled"));
	await writeFile(
		join(packagesDirectory, "plugin-garbled", "package.json"),
		'{ "name": "@fixture/plugin-garbled", ',
	);
	await mkdir(join(packagesDirectory, "not-a-package"));
	await writeFile(join(packagesDirectory, "README.md"), "not a directory");
});

afterAll(async () => {
	await rm(packagesDirectory, { recursive: true, force: true });
	for (const directory of temporaryDirectories)
		await rm(directory, { recursive: true, force: true });
});

describe("plugin discovery", () => {
	test("finds the packages that declare a plugin, in a stable order", async () => {
		const { packages } = await discoverPluginPackages(packagesDirectory)();

		expect(
			packages.map(({ packageName, pluginName, version }) => ({
				packageName,
				pluginName,
				version,
			})),
		).toEqual([
			{
				packageName: "@fixture/plugin-broken",
				pluginName: "broken",
				version: "0.1.0",
			},
			{
				packageName: "@fixture/plugin-notes",
				pluginName: "notes",
				version: "1.2.3",
			},
		]);
	});

	test("loads the default export of the plugin entry on demand", async () => {
		const { packages } = await discoverPluginPackages(packagesDirectory)();

		const definition = await packages[1]?.loadDefinition();

		expect(definition).toEqual({ manifest: { name: "notes" } });
	});

	test("leaves a plugin entry that fails on import to the caller", async () => {
		const { packages } = await discoverPluginPackages(packagesDirectory)();

		const loading = packages[0]?.loadDefinition();

		await expect(loading).rejects.toThrow(TypeError);
	});

	test("reports the packages whose package.json it cannot use and still finds the others", async () => {
		const { packages, unreadable } =
			await discoverPluginPackages(packagesDirectory)();

		const declaration =
			'workbench.plugin must declare the plugin "name" (lowercase letters, digits and hyphens, starting with a letter) and the "entry" path';
		expect(unreadable).toEqual([
			{
				directory: join(packagesDirectory, "plugin-garbled"),
				problem: "package.json is not valid JSON",
			},
			{
				directory: join(packagesDirectory, "plugin-old-style"),
				problem: declaration,
			},
			{
				directory: join(packagesDirectory, "plugin-unnamed"),
				problem: declaration,
			},
		]);
		expect(packages.map(({ pluginName }) => pluginName)).toEqual([
			"broken",
			"notes",
		]);
	});

	test.each([
		["is empty", () => ""],
		["names the package itself", () => "."],
		["leaves the package", () => "../outside/plugin.ts"],
		["leaves the package midway", () => "src/../../outside/plugin.ts"],
		["is absolute", (root: string) => join(root, "src", "plugin.ts")],
	])("reports a package whose plugin entry %s", async (_case, entryOf) => {
		const directory = await temporaryDirectory();
		const root = join(directory, "plugin-notes");
		await writeNotesPlugin(root, entryOf(root));
		await mkdir(join(directory, "outside"));
		await writeFile(
			join(directory, "outside", "plugin.ts"),
			'export default { manifest: { name: "notes" } };',
		);

		const discovery = await discoverPluginPackages(directory)();

		expect(discovery).toEqual({
			packages: [],
			unreadable: [
				{
					directory: root,
					problem:
						'workbench.plugin "entry" must be a relative path to a file inside the package',
				},
			],
		});
	});

	test("finds and loads a plugin package that is linked into the directory", async () => {
		const directory = await temporaryDirectory();
		const elsewhere = await temporaryDirectory();
		await writeNotesPlugin(join(elsewhere, "notes"), "./src/plugin.ts");
		await symlink(join(elsewhere, "notes"), join(directory, "plugin-notes"));

		const { packages, unreadable } = await discoverPluginPackages(directory)();
		const definition = await packages[0]?.loadDefinition();

		expect(packages.map(({ pluginName }) => pluginName)).toEqual(["notes"]);
		expect(unreadable).toEqual([]);
		expect(definition).toEqual({ manifest: { name: "notes" } });
	});

	test("skips links that do not lead to a package", async () => {
		const directory = await temporaryDirectory();
		await writeFile(join(directory, "README.md"), "not a directory");
		await symlink(join(directory, "README.md"), join(directory, "to-a-file"));
		await symlink(join(directory, "gone"), join(directory, "to-nothing"));
		await symlink(join(directory, "to-itself"), join(directory, "to-itself"));

		const discovery = await discoverPluginPackages(directory)();

		expect(discovery).toEqual({ packages: [], unreadable: [] });
	});

	test("fails when the directory cannot be read", async () => {
		const discover = discoverPluginPackages(
			join(packagesDirectory, "does-not-exist"),
		);

		await expect(discover()).rejects.toMatchObject({ code: "ENOENT" });
	});
});
