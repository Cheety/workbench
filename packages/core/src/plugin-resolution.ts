import type { LoadFailure, LoadFailures } from "./load-failures.ts";
import type { ValidPlugin } from "./plugin-manifest.ts";
import { quote } from "./quote.ts";

/**
 * Decides which of the enabled plugins can be loaded and returns them with
 * every required plugin before the plugins that require it. Everything else
 * is rejected with the reason; a plugin that requires a rejected plugin is
 * rejected too, and its reason quotes the cause.
 */
export function resolvePlugins(
	installed: ReadonlyMap<string, ValidPlugin>,
	enabledPlugins: readonly string[],
	failures: LoadFailures,
): readonly ValidPlugin[] {
	const enabled = new Set(enabledPlugins);
	const activationOrder: ValidPlugin[] = [];
	const resolved = new Map<string, ValidPlugin>();
	const resolving: string[] = [];

	const rejected = (failure: LoadFailure): LoadFailure => {
		failures.reject(failure);
		return failure;
	};

	const resolve = (name: string): ValidPlugin | LoadFailure => {
		const known = resolved.get(name) ?? failures.find(name);
		if (known !== undefined) return known;
		const plugin = installed.get(name);
		if (plugin === undefined) return rejected(unknownPlugin(name));
		const failure = firstRequirementFailure(plugin);
		if (failure !== undefined) return rejected(failure);
		resolved.set(name, plugin);
		activationOrder.push(plugin);
		return plugin;
	};

	const firstRequirementFailure = (
		plugin: ValidPlugin,
	): LoadFailure | undefined => {
		resolving.push(plugin.name);
		try {
			for (const [required, range] of plugin.requires) {
				const failure = requirementFailure(plugin, required, range);
				if (failure !== undefined) return failure;
			}
			return undefined;
		} finally {
			resolving.pop();
		}
	};

	const requirementFailure = (
		plugin: ValidPlugin,
		required: string,
		range: string,
	): LoadFailure | undefined => {
		const requirement = `plugin ${quote(plugin.name)} requires plugin ${quote(required)}`;
		if (resolving.includes(required)) {
			const cycle = [...resolving.slice(resolving.indexOf(required)), required];
			return {
				plugin: plugin.name,
				reason: "dependency_cycle",
				detail: `plugin ${quote(plugin.name)} is part of a dependency cycle: ${cycle.join(" -> ")}`,
			};
		}
		if (!enabled.has(required) && failures.find(required) === undefined) {
			const state = installed.has(required)
				? "not enabled in the instance config"
				: "not installed";
			return {
				plugin: plugin.name,
				reason: "missing_dependency",
				detail: `${requirement} (${range}), which is ${state}`,
			};
		}
		const requiredPlugin = resolve(required);
		if (isLoadFailure(requiredPlugin))
			return dependencyNotLoaded(plugin, required, requiredPlugin);
		if (!Bun.semver.satisfies(requiredPlugin.version, range)) {
			return {
				plugin: plugin.name,
				reason: "version_mismatch",
				detail: `${requirement} in a version matching ${range}, but ${requiredPlugin.version} is installed`,
			};
		}
		return undefined;
	};

	for (const name of enabledPlugins) resolve(name);
	return activationOrder;
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

function unknownPlugin(name: string): LoadFailure {
	return {
		plugin: name,
		reason: "unknown_plugin",
		detail: `plugin ${quote(name)} is enabled in the instance config, but no plugin package provides it`,
	};
}

function isLoadFailure(
	outcome: ValidPlugin | LoadFailure,
): outcome is LoadFailure {
	return "reason" in outcome;
}
