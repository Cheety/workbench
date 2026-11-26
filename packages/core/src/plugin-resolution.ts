import type { LoadFailure, LoadFailures } from "./load-failures.ts";
import type { PluginCatalog, PluginLoad } from "./plugin-catalog.ts";
import type { ValidPlugin } from "./plugin-manifest.ts";
import { quote } from "./quote.ts";

/**
 * Decides which of the enabled plugins can be loaded and returns them with
 * every required plugin before the plugins that require it. Everything else
 * is rejected with the reason; a plugin that requires a rejected plugin is
 * rejected too, and its reason quotes the cause. Plugins that require each
 * other in a cycle are each rejected for the cycle.
 *
 * Only enabled plugins are loaded from the catalog, so no code of any other
 * plugin runs and none of them is rejected.
 */
export async function resolvePlugins(
	catalog: PluginCatalog,
	enabledPlugins: readonly string[],
	failures: LoadFailures,
): Promise<readonly ValidPlugin[]> {
	const enabled = new Set(enabledPlugins);
	const activationOrder: ValidPlugin[] = [];
	const resolved = new Map<string, ValidPlugin>();
	const resolving: string[] = [];
	/** Plugin name → the dependency cycle the plugin was found in. */
	const cycles = new Map<string, string>();

	const rejected = (failure: LoadFailure): PluginLoad => {
		failures.reject(failure);
		return { loaded: false, failure };
	};

	const resolve = async (name: string): Promise<PluginLoad> => {
		const plugin = resolved.get(name);
		if (plugin !== undefined) return { loaded: true, plugin };
		const known = failures.find(name);
		if (known !== undefined) return { loaded: false, failure: known };
		const load = await catalog.load(name);
		if (!load.loaded) return rejected(load.failure);
		const failure = await firstRequirementFailure(load.plugin);
		if (failure !== undefined) return rejected(failure);
		resolved.set(name, load.plugin);
		activationOrder.push(load.plugin);
		return load;
	};

	const firstRequirementFailure = async (
		plugin: ValidPlugin,
	): Promise<LoadFailure | undefined> => {
		resolving.push(plugin.name);
		try {
			for (const [required, range] of plugin.requires) {
				const failure = await requirementFailure(plugin, required, range);
				if (failure !== undefined) return failure;
			}
			return undefined;
		} finally {
			resolving.pop();
		}
	};

	const requirementFailure = async (
		plugin: ValidPlugin,
		required: string,
		range: string,
	): Promise<LoadFailure | undefined> => {
		const requirement = `plugin ${quote(plugin.name)} requires plugin ${quote(required)}`;
		if (resolving.includes(required)) {
			const members = resolving.slice(resolving.indexOf(required));
			const cycle = [...members, required].join(" -> ");
			for (const member of members) cycles.set(member, cycle);
			return dependencyCycle(plugin, cycle);
		}
		if (!enabled.has(required)) {
			const state = catalog.isDiscovered(required)
				? "not enabled in the instance config"
				: "not installed";
			return {
				plugin: plugin.name,
				reason: "missing_dependency",
				detail: `${requirement} (${range}), which is ${state}`,
			};
		}
		const requiredPlugin = await resolve(required);
		if (!requiredPlugin.loaded) {
			const cycle = cycles.get(plugin.name);
			return cycle === undefined
				? dependencyNotLoaded(plugin, required, requiredPlugin.failure)
				: dependencyCycle(plugin, cycle);
		}
		const { version } = requiredPlugin.plugin;
		if (!Bun.semver.satisfies(version, range)) {
			return {
				plugin: plugin.name,
				reason: "version_mismatch",
				detail: `${requirement} in a version matching ${range}, but ${version} is installed`,
			};
		}
		return undefined;
	};

	for (const name of enabledPlugins) await resolve(name);
	return activationOrder;
}

function dependencyCycle(plugin: ValidPlugin, cycle: string): LoadFailure {
	return {
		plugin: plugin.name,
		reason: "dependency_cycle",
		detail: `plugin ${quote(plugin.name)} is part of a dependency cycle: ${cycle}`,
	};
}

export function dependencyNotLoaded(
	plugin: ValidPlugin,
	required: string,
	cause: LoadFailure,
): LoadFailure {
	return {
		plugin: plugin.name,
		reason: "dependency_not_loaded",
		detail: `plugin ${quote(plugin.name)} requires plugin ${quote(required)}, which was not loaded: ${cause.detail}`,
	};
}
