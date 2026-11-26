import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPluginPackages } from "./plugin-discovery.ts";

let packagesDirectory: string;

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

	test("fails when the directory cannot be read", async () => {
		const discover = discoverPluginPackages(
			join(packagesDirectory, "does-not-exist"),
		);

		await expect(discover()).rejects.toMatchObject({ code: "ENOENT" });
	});
});
