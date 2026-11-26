import type { LoadFailure, LoadFailures } from "./load-failures.ts";
import type { PluginCatalog, PluginLoad } from "./plugin-catalog.ts";
import type { ValidPlugin } from "./plugin-manifest.ts";
import { quote } from "./quote.ts";

export async function resolvePlugins(
	catalog: PluginCatalog,
	enabledPlugins: readonly string[],
	failures: LoadFailures,
): Promise<readonly ValidPlugin[]> {
	const loads = new Map<string, PluginLoad>();
	for (const name of new Set(enabledPlugins))
		loads.set(name, await catalog.load(name));
	const cycles = findDependencyCycles(loads);
	const activationOrder: ValidPlugin[] = [];
	const resolved = new Map<string, ValidPlugin>();
	const resolving: string[] = [];

	const rejected = (failure: LoadFailure): PluginLoad => {
		failures.reject(failure);
		return { loaded: false, failure };
	};

	const resolve = async (name: string): Promise<PluginLoad> => {
		const plugin = resolved.get(name);
		if (plugin !== undefined) return { loaded: true, plugin };
		const known = failures.find(name);
		if (known !== undefined) return { loaded: false, failure: known };
		const load = loads.get(name) ?? (await catalog.load(name));
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
		const cycle = cycles.get(plugin.name);
		if (cycle !== undefined && resolving.includes(required))
			return dependencyCycle(plugin, cycle);
		if (!loads.has(required)) {
			const state = catalog.isDiscovered(required)
				? "is not enabled in the instance config"
				: "no plugin package provides";
			return {
				plugin: plugin.name,
				reason: "missing_dependency",
				detail: `${requirement} (${range}), which ${state}`,
			};
		}
		const requiredPlugin = await resolve(required);
		if (!requiredPlugin.loaded) {
			return cycle === undefined
				? dependencyNotLoaded(plugin, required, requiredPlugin.failure)
				: dependencyCycle(plugin, cycle);
		}
		const { version } = requiredPlugin.plugin;
		if (!Bun.semver.satisfies(version, range)) {
			return {
				plugin: plugin.name,
				reason: "version_mismatch",
				detail: `${requirement} in a version matching ${range}, but its version is ${version}`,
			};
		}
		return undefined;
	};

	for (const name of enabledPlugins) await resolve(name);
	return activationOrder;
}

function findDependencyCycles(
	loads: ReadonlyMap<string, PluginLoad>,
): ReadonlyMap<string, string> {
	const cycles = new Map<string, string>();
	for (const name of loads.keys()) {
		if (cycles.has(name)) continue;
		const members = shortestCycleThrough(name, loads);
		if (members === undefined) continue;
		const cycle = [...members, name].join(" -> ");
		for (const member of members)
			if (!cycles.has(member)) cycles.set(member, cycle);
	}
	return cycles;
}

function shortestCycleThrough(
	start: string,
	loads: ReadonlyMap<string, PluginLoad>,
): readonly string[] | undefined {
	const paths = new Map<string, readonly string[]>([[start, [start]]]);
	for (const [name, path] of paths) {
		const load = loads.get(name);
		if (!load?.loaded) continue;
		for (const required of load.plugin.requires.keys()) {
			if (required === start) return path;
			if (!paths.has(required)) paths.set(required, [...path, required]);
		}
	}
	return undefined;
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
