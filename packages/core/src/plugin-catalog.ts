import { describeThrown, summarize } from "./failure-reason.ts";
import type { LoadFailure } from "./load-failures.ts";
import { type ValidPlugin, validatePlugin } from "./plugin-manifest.ts";
import { quote } from "./quote.ts";

/** A plugin package as discovery found it, before anything is validated. */
export type PluginPackage = {
	readonly packageName: string;
	/** The plugin name the package's `package.json` declares. */
	readonly pluginName: string;
	/** The `version` of the package's `package.json`, as found. */
	readonly version: unknown;
	/** Loads the default export of the plugin entry; this runs plugin code. */
	readonly loadDefinition: () => Promise<unknown>;
};

/** A package directory whose `package.json` discovery could not use. */
export type UnreadablePackage = {
	readonly directory: string;
	readonly problem: string;
};

export type PluginDiscovery = {
	readonly packages: readonly PluginPackage[];
	readonly unreadable: readonly UnreadablePackage[];
};

export type PluginLoad =
	| { readonly loaded: true; readonly plugin: ValidPlugin }
	| { readonly loaded: false; readonly failure: LoadFailure };

/** The discovered plugins by the name their plugin package declares. */
export type PluginCatalog = {
	isDiscovered(name: string): boolean;
	/**
	 * Loads and validates the entry of the plugin package that declares `name`.
	 * A name that no plugin package or more than one declares is a load failure,
	 * and no entry is loaded for it.
	 */
	load(name: string): Promise<PluginLoad>;
};

export function catalogPlugins(
	packages: readonly PluginPackage[],
	offeredCapabilities: readonly string[],
): PluginCatalog {
	const declaring = Map.groupBy(
		packages,
		(pluginPackage) => pluginPackage.pluginName,
	);
	return {
		isDiscovered: (name) => declaring.has(name),
		load: async (name) => {
			const [pluginPackage, ...others] = declaring.get(name) ?? [];
			if (pluginPackage === undefined) return notLoaded(unknownPlugin(name));
			if (others.length > 0)
				return notLoaded(duplicatePlugin(name, [pluginPackage, ...others]));
			return loadPlugin(pluginPackage, offeredCapabilities);
		},
	};
}

async function loadPlugin(
	pluginPackage: PluginPackage,
	offeredCapabilities: readonly string[],
): Promise<PluginLoad> {
	const { pluginName: declaredName, version } = pluginPackage;
	let definition: unknown;
	try {
		definition = await pluginPackage.loadDefinition();
	} catch (error) {
		const thrown = describeThrown(error);
		return notLoaded({
			...invalidManifest(pluginPackage, [
				`plugin entry failed to load (${summarize(thrown)})`,
			]),
			error: thrown,
		});
	}
	const validation = validatePlugin(
		{ declaredName, version, definition },
		offeredCapabilities,
	);
	return validation.valid
		? { loaded: true, plugin: validation.plugin }
		: notLoaded(invalidManifest(pluginPackage, validation.problems));
}

function notLoaded(failure: LoadFailure): PluginLoad {
	return { loaded: false, failure };
}

function invalidManifest(
	pluginPackage: PluginPackage,
	problems: readonly string[],
): LoadFailure {
	return {
		plugin: pluginPackage.pluginName,
		reason: "invalid_manifest",
		detail: `plugin package ${quote(pluginPackage.packageName)} has an invalid manifest: ${problems.join("; ")}`,
	};
}

function unknownPlugin(name: string): LoadFailure {
	return {
		plugin: name,
		reason: "unknown_plugin",
		detail: `plugin ${quote(name)} is enabled in the instance config, but no plugin package provides it`,
	};
}

function duplicatePlugin(
	name: string,
	packages: readonly PluginPackage[],
): LoadFailure {
	const packageNames = packages.map(({ packageName }) => quote(packageName));
	return {
		plugin: name,
		reason: "duplicate_plugin",
		detail: `plugin ${quote(name)} is declared by several plugin packages: ${packageNames.join(", ")}`,
	};
}
