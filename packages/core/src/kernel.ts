import type { PluginContext } from "@workbench/sdk";
import { describeThrown, summarize } from "./failure-reason.ts";
import { type HookTimeout, runWithin } from "./hook-timeout.ts";
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

export type { HookTimeout } from "./hook-timeout.ts";
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
	readonly hookTimeout: HookTimeout;
	/**
	 * Once aborted, the start loads and activates no further plugin; a hook
	 * that is already running is still waited for.
	 */
	readonly stopSignal?: AbortSignal;
	readonly logger: Logger;
};

export type DeactivationOutcome = "clean" | "incomplete";

export type RunningPlugins = {
	/** Names of the active plugins, in activation order. */
	readonly active: readonly string[];
	readonly failures: readonly LoadFailure[];
	/**
	 * Deactivates the active plugins in reverse activation order. A plugin that
	 * fails to deactivate, or does not finish within the hook timeout, is logged
	 * and does not stop the others; the outcome is then "incomplete". Repeated
	 * calls share one deactivation.
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
 * A plugin whose entry does not finish loading within the hook timeout is not
 * loaded. A plugin whose `activate` throws or does not finish within the hook
 * timeout is not loaded and is not deactivated later.
 *
 * Never rejects because of a plugin: every plugin that cannot be loaded is
 * logged as "plugin not loaded" and listed in `failures`, the others run. A
 * package whose `package.json` discovery could not use is logged as "plugin
 * package ignored" with its directory.
 *
 * A start that is told to stop logs "plugin start stopped" with the plugins it
 * did not activate; these are no load failures.
 */
export async function startPlugins(
	options: KernelOptions,
): Promise<RunningPlugins> {
	const { logger } = options;
	const failures = new LoadFailures(logger);

	const packages = await discoverPackages(options);
	const active = await activateEnabledPlugins(packages, options, failures);
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
			deactivation ??= deactivate(active, options);
			return deactivation;
		},
	};
}

async function activateEnabledPlugins(
	packages: readonly PluginPackage[],
	options: KernelOptions,
	failures: LoadFailures,
): Promise<readonly ValidPlugin[]> {
	const { logger, stopSignal } = options;
	const active: ValidPlugin[] = [];
	if (stopSignal?.aborted) {
		logger.info("plugin start stopped", {
			notActivated: options.enabledPlugins,
		});
		return active;
	}
	const activationOrder = await resolvePlugins(
		catalogPlugins(
			packages,
			Object.keys(options.capabilityProviders),
			options.hookTimeout,
		),
		options.enabledPlugins,
		failures,
	);
	logger.info("plugins resolved", {
		activationOrder: activationOrder.map((plugin) => plugin.name),
	});
	for (const [position, plugin] of activationOrder.entries()) {
		if (stopSignal?.aborted) {
			logger.info("plugin start stopped", {
				notActivated: activationOrder
					.slice(position)
					.map((remaining) => remaining.name),
			});
			break;
		}
		const failure = await activate(plugin, options, failures);
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
	return active;
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
	{ capabilityProviders, hookTimeout }: KernelOptions,
	failures: LoadFailures,
): Promise<LoadFailure | undefined> {
	for (const required of plugin.requires.keys()) {
		const cause = failures.find(required);
		if (cause !== undefined)
			return dependencyNotLoaded(plugin, required, cause);
	}
	try {
		const outcome = await runWithin(
			() => plugin.activate(contextFor(plugin, capabilityProviders)),
			hookTimeout,
		);
		if (outcome === "finished") return undefined;
		return {
			plugin: plugin.name,
			reason: "activation_timed_out",
			detail: `plugin ${quote(plugin.name)} did not finish activating within ${hookTimeout.ms} ms`,
		};
	} catch (error) {
		const thrown = describeThrown(error);
		return {
			plugin: plugin.name,
			reason: "activation_failed",
			detail: `plugin ${quote(plugin.name)} failed to activate (${summarize(thrown)})`,
			error: thrown,
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
	{ hookTimeout, logger }: KernelOptions,
): Promise<DeactivationOutcome> {
	let outcome: DeactivationOutcome = "clean";
	for (const plugin of active.toReversed()) {
		try {
			const hook = await runWithin(() => plugin.deactivate(), hookTimeout);
			if (hook === "finished") {
				logger.info("plugin deactivated", { plugin: plugin.name });
				continue;
			}
			logger.error("plugin deactivation timed out", {
				plugin: plugin.name,
				timeoutMs: hookTimeout.ms,
			});
		} catch (error) {
			logger.error("plugin failed to deactivate", {
				plugin: plugin.name,
				error: describeThrown(error),
			});
		}
		outcome = "incomplete";
	}
	return outcome;
}
