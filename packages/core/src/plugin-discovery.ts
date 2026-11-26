import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginDiscovery, PluginPackage } from "./kernel.ts";
import { isPluginName } from "./plugin-manifest.ts";
import { systemFailureReason } from "./system-error.ts";

const PACKAGE_JSON = "package.json";

const NOTHING: PluginDiscovery = { packages: [], unreadable: [] };

/**
 * Finds the plugin packages among the packages in `packagesDirectory`: those
 * whose `package.json` declares a plugin in `workbench.plugin`, with the plugin
 * `name` and the `entry`, a relative path to a file inside the package
 * (ADR-0007). Other directories are not plugins and are skipped. No plugin code
 * is loaded before `loadDefinition` is called.
 *
 * A package whose `package.json` cannot be read or declares a plugin in
 * another shape is listed in `unreadable` and does not keep the others from
 * being found. The returned function rejects if the directory itself cannot
 * be read.
 */
export function discoverPluginPackages(
	packagesDirectory: string,
): () => Promise<PluginDiscovery> {
	return async () => {
		const entries = await readdir(packagesDirectory, { withFileTypes: true });
		const directories = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		const found = await Promise.all(
			directories.map((directory) =>
				readPackage(join(packagesDirectory, directory)),
			),
		);
		return {
			packages: found.flatMap(({ packages }) => packages),
			unreadable: found.flatMap(({ unreadable }) => unreadable),
		};
	};
}

async function readPackage(root: string): Promise<PluginDiscovery> {
	const file = Bun.file(join(root, PACKAGE_JSON));
	if (!(await file.exists())) return NOTHING;
	let packageJson: unknown;
	try {
		packageJson = await file.json();
	} catch (error) {
		return unreadable(
			root,
			error instanceof SyntaxError
				? `${PACKAGE_JSON} is not valid JSON`
				: `${PACKAGE_JSON} cannot be read (${systemFailureReason(error)})`,
		);
	}
	if (!isRecord(packageJson) || !isRecord(packageJson.workbench))
		return NOTHING;
	const declared = packageJson.workbench.plugin;
	if (declared === undefined) return NOTHING;
	const { name: pluginName = undefined, entry = undefined } = isRecord(declared)
		? declared
		: {};
	if (!isPluginName(pluginName) || typeof entry !== "string") {
		return unreadable(
			root,
			'workbench.plugin must declare the plugin "name" (lowercase letters, digits and hyphens, starting with a letter) and the "entry" path',
		);
	}
	const entryPath = entryPathInside(root, entry);
	if (entryPath === undefined) {
		return unreadable(
			root,
			'workbench.plugin "entry" must be a relative path to a file inside the package',
		);
	}
	const pluginPackage: PluginPackage = {
		packageName: typeof packageJson.name === "string" ? packageJson.name : root,
		pluginName,
		version: packageJson.version,
		loadDefinition: async () => {
			const module: unknown = await import(pathToFileURL(entryPath).href);
			return isRecord(module) ? module.default : undefined;
		},
	};
	return { packages: [pluginPackage], unreadable: [] };
}

function entryPathInside(root: string, entry: string): string | undefined {
	if (isAbsolute(entry)) return undefined;
	const entryPath = resolve(root, entry);
	const fromRoot = relative(resolve(root), entryPath);
	const isInside =
		fromRoot !== "" &&
		fromRoot !== ".." &&
		!fromRoot.startsWith(`..${sep}`) &&
		!isAbsolute(fromRoot);
	return isInside ? entryPath : undefined;
}

function unreadable(directory: string, problem: string): PluginDiscovery {
	return { packages: [], unreadable: [{ directory, problem }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
