import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginDiscovery, PluginPackage } from "./kernel.ts";
import { readMigrations } from "./migration-files.ts";
import { isPluginName } from "./plugin-manifest.ts";
import { systemFailureReason } from "./system-error.ts";

const PACKAGE_JSON = "package.json";

const NOTHING: PluginDiscovery = { packages: [], unreadable: [] };

export function discoverPluginPackages(
	packagesDirectory: string,
): () => Promise<PluginDiscovery> {
	return async () => {
		const entries = await readdir(packagesDirectory, { withFileTypes: true });
		const directories = entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort();
		const found = await Promise.all(
			directories.map((directory) =>
				readPluginPackage(join(packagesDirectory, directory)),
			),
		);
		return {
			packages: found.flatMap(({ packages }) => packages),
			unreadable: found.flatMap(({ unreadable }) => unreadable),
		};
	};
}

export async function readPluginPackage(
	root: string,
): Promise<PluginDiscovery> {
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
	const {
		name: pluginName = undefined,
		entry = undefined,
		migrations = undefined,
	} = isRecord(declared) ? declared : {};
	if (!isPluginName(pluginName) || typeof entry !== "string") {
		return unreadable(
			root,
			'workbench.plugin must declare the plugin "name" (lowercase letters, digits and hyphens, starting with a letter) and the "entry" path',
		);
	}
	const entryPath = pathInside(root, entry);
	if (entryPath === undefined) {
		return unreadable(
			root,
			'workbench.plugin "entry" must be a relative path to a file inside the package',
		);
	}
	const migrationsPath =
		typeof migrations === "string" ? pathInside(root, migrations) : undefined;
	if (migrations !== undefined && migrationsPath === undefined) {
		return unreadable(
			root,
			'workbench.plugin "migrations" must be a relative path to a directory inside the package',
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
		...(migrationsPath === undefined
			? {}
			: { loadMigrations: () => readMigrations(migrationsPath) }),
	};
	return { packages: [pluginPackage], unreadable: [] };
}

function pathInside(root: string, path: string): string | undefined {
	if (isAbsolute(path)) return undefined;
	const resolved = resolve(root, path);
	const fromRoot = relative(resolve(root), resolved);
	const isInside =
		fromRoot !== "" &&
		fromRoot !== ".." &&
		!fromRoot.startsWith(`..${sep}`) &&
		!isAbsolute(fromRoot);
	return isInside ? resolved : undefined;
}

function unreadable(directory: string, problem: string): PluginDiscovery {
	return { packages: [], unreadable: [{ directory, problem }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
