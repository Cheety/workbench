import type { PluginContext } from "@workbench/sdk";
import { errorName } from "./failure-reason.ts";
import { type LoadFailure, LoadFailures } from "./load-failures.ts";
import type { Logger } from "./logger.ts";
import {
	catalogPlugins,
	type PluginDiscovery,
	type PluginPackage,
} from "./plugin-catalog.ts";
import type { ValidPlugin } from "./plugin-manifest.ts";
import { dependencyNotLoaded, resolvePlugins } from "./plugin-resolution.ts";
import { quote } from "./quote.ts";
import { systemFailureReason } from "./system-error.ts";

export type { LoadFailure } from "./load-failures.ts";
export type {
	PluginDiscovery,
	PluginPackage,
	UnreadablePackage,
} from "./plugin-catalog.ts";

/**
 * The capabilities this instance offers, by name. A provider is called once
 * for each plugin that declares the capability.
 */
export type CapabilityProviders = Readonly<Record<string, () => unknown>>;

export type KernelOptions = {
	readonly discover: () => Promise<PluginDiscovery>;
	/** Plugin names from the instance config. */
	readonly enabledPlugins: readonly string[];
	readonly capabilityProviders: CapabilityProviders;
	readonly logger: Logger;
};

export type DeactivationOutcome = "clean" | "incomplete";

export type RunningPlugins = {
	/** Names of the active plugins, in activation order. */
	readonly active: readonly string[];
	readonly failures: readonly LoadFailure[];
	/**
	 * Deactivates the active plugins in reverse activation order. A plugin that
	 * fails to deactivate is logged and does not stop the others. Repeated calls
	 * share one deactivation.
	 */
	deactivate(): Promise<DeactivationOutcome>;
};

export class UndeclaredCapabilityError extends Error {
	constructor(plugin: string, capability: string) {
		super(
			`plugin ${quote(plugin)} did not declare the capability ${quote(capability)} in its manifest`,
		);
		this.name = "UndeclaredCapabilityError";
	}
}

/**
 * Runs the plugin lifecycle up to activation: discover the plugin packages,
 * resolve what the instance config enables, activate in dependency order.
 * Plugins the instance config does not enable are left alone: their entries
 * are not loaded and their defects are not reported.
 *
 * Never rejects because of a plugin: every plugin that cannot be loaded is
 * logged as "plugin not loaded" and listed in `failures`, the others run. A
 * package whose `package.json` discovery could not use is logged as "plugin
 * package ignored" with its directory.
 */
export async function startPlugins(
	options: KernelOptions,
): Promise<RunningPlugins> {
	const { logger } = options;
	const failures = new LoadFailures(logger);

	const packages = await discoverPackages(options);
	const activationOrder = await resolvePlugins(
		catalogPlugins(packages, Object.keys(options.capabilityProviders)),
		options.enabledPlugins,
		failures,
	);
	logger.info("plugins resolved", {
		activationOrder: activationOrder.map((plugin) => plugin.name),
	});

	const active: ValidPlugin[] = [];
	for (const plugin of activationOrder) {
		const failure = await activate(
			plugin,
			options.capabilityProviders,
			failures,
		);
		if (failure !== undefined) {
			failures.reject(failure);
			continue;
		}
		active.push(plugin);
		logger.info("plugin activated", {
			plugin: plugin.name,
			version: plugin.version,
		});
	}
	const activeNames = active.map((plugin) => plugin.name);
	logger.info("plugins started", {
		active: activeNames,
		notLoaded: failures.all.map((failure) => failure.plugin),
	});

	let deactivation: Promise<DeactivationOutcome> | undefined;
	return {
		active: activeNames,
		failures: failures.all,
		deactivate: () => {
			deactivation ??= deactivate(active, logger);
			return deactivation;
		},
	};
}

async function discoverPackages(
	options: KernelOptions,
): Promise<readonly PluginPackage[]> {
	try {
		const { packages, unreadable } = await options.discover();
		for (const unreadablePackage of unreadable)
			options.logger.error("plugin package ignored", unreadablePackage);
		options.logger.info("plugins discovered", {
			packages: packages.map((pluginPackage) => pluginPackage.packageName),
		});
		return packages;
	} catch (error) {
		options.logger.error("plugin discovery failed", {
			reason: systemFailureReason(error),
		});
		return [];
	}
}

async function activate(
	plugin: ValidPlugin,
	providers: CapabilityProviders,
	failures: LoadFailures,
): Promise<LoadFailure | undefined> {
	for (const required of plugin.requires.keys()) {
		const cause = failures.find(required);
		if (cause !== undefined)
			return dependencyNotLoaded(plugin, required, cause);
	}
	try {
		await plugin.activate(contextFor(plugin, providers));
		return undefined;
	} catch (error) {
		return {
			plugin: plugin.name,
			reason: "activation_failed",
			detail: `plugin ${quote(plugin.name)} failed to activate (${errorName(error)})`,
		};
	}
}

function contextFor(
	plugin: ValidPlugin,
	providers: CapabilityProviders,
): PluginContext {
	const granted = new Map(
		plugin.capabilities.map((capability) => [
			capability,
			providers[capability]?.(),
		]),
	);
	return {
		capability: (name) => {
			if (!granted.has(name))
				throw new UndeclaredCapabilityError(plugin.name, name);
			return granted.get(name);
		},
	};
}

async function deactivate(
	active: readonly ValidPlugin[],
	logger: Logger,
): Promise<DeactivationOutcome> {
	let outcome: DeactivationOutcome = "clean";
	for (const plugin of active.toReversed()) {
		try {
			await plugin.deactivate();
			logger.info("plugin deactivated", { plugin: plugin.name });
		} catch (error) {
			outcome = "incomplete";
			logger.error("plugin failed to deactivate", {
				plugin: plugin.name,
				reason: errorName(error),
			});
		}
	}
	return outcome;
}
