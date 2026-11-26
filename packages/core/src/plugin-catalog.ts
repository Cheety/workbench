import { describeThrown, summarize } from "./failure-reason.ts";
import { type HookTimeout, runWithin } from "./hook-timeout.ts";
import type { LoadFailure } from "./load-failures.ts";
import { type ValidPlugin, validatePlugin } from "./plugin-manifest.ts";
import { quote } from "./quote.ts";

export type PluginPackage = {
	readonly packageName: string;
	readonly pluginName: string;
	readonly version: unknown;
	readonly loadDefinition: () => Promise<unknown>;
};

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

export type PluginCatalog = {
	isDiscovered(name: string): boolean;
	load(name: string): Promise<PluginLoad>;
};

export function catalogPlugins(
	packages: readonly PluginPackage[],
	offeredCapabilities: readonly string[],
	loadTimeout: HookTimeout,
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
			return loadPlugin(pluginPackage, offeredCapabilities, loadTimeout);
		},
	};
}

async function loadPlugin(
	pluginPackage: PluginPackage,
	offeredCapabilities: readonly string[],
	loadTimeout: HookTimeout,
): Promise<PluginLoad> {
	const { pluginName: declaredName, version } = pluginPackage;
	let definition: unknown;
	try {
		const outcome = await runWithin(
			() =>
				pluginPackage.loadDefinition().then((loaded) => {
					definition = loaded;
				}),
			loadTimeout,
		);
		if (outcome === "timed_out")
			return notLoaded(loadTimedOut(pluginPackage, loadTimeout));
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

function loadTimedOut(
	pluginPackage: PluginPackage,
	loadTimeout: HookTimeout,
): LoadFailure {
	return {
		plugin: pluginPackage.pluginName,
		reason: "load_timed_out",
		detail: `plugin package ${quote(pluginPackage.packageName)} did not finish loading its plugin entry within ${loadTimeout.ms} ms`,
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
