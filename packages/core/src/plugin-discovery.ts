import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginPackage } from "./kernel.ts";

const PACKAGE_JSON = "package.json";

/**
 * Finds the plugin packages among the packages in `packagesDirectory`: those
 * whose `package.json` names a plugin entry in `workbench.plugin`, a path
 * relative to the package (ADR-0007). Other directories are not plugins and
 * are skipped. No plugin code is loaded before `loadDefinition` is called.
 *
 * The returned function rejects if the directory or a `package.json` in it
 * cannot be read.
 */
export function discoverPluginPackages(
	packagesDirectory: string,
): () => Promise<readonly PluginPackage[]> {
	return async () => {
		const entries = await readdir(packagesDirectory, { withFileTypes: true });
		const directories = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		const found = await Promise.all(
			directories.map((directory) =>
				readPluginPackage(join(packagesDirectory, directory)),
			),
		);
		return found.filter((pluginPackage) => pluginPackage !== undefined);
	};
}

async function readPluginPackage(
	root: string,
): Promise<PluginPackage | undefined> {
	const file = Bun.file(join(root, PACKAGE_JSON));
	if (!(await file.exists())) return undefined;
	const packageJson: unknown = await file.json();
	if (!isRecord(packageJson) || !isRecord(packageJson.workbench))
		return undefined;
	const entry = packageJson.workbench.plugin;
	if (typeof entry !== "string") return undefined;
	return {
		packageName: typeof packageJson.name === "string" ? packageJson.name : root,
		version: packageJson.version,
		loadDefinition: async () => {
			const module: unknown = await import(
				pathToFileURL(join(root, entry)).href
			);
			return isRecord(module) ? module.default : undefined;
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
