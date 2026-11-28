import {
	DATABASE_CAPABILITY,
	type DatabaseCapability,
	type EventSubscriptionCapability,
	type PluginContext,
	subscribedEventOf,
} from "@workbench/sdk";
import { CORE_JOBS } from "./core-jobs.ts";
import { CORE_OPERATIONS } from "./core-operations.ts";
import { type EventRegistry, registerEvents } from "./event-registry.ts";
import {
	describeThrown,
	summarize,
	type ThrownError,
	UNKNOWN_FAILURE_REASON,
} from "./failure-reason.ts";
import { type HookTimeout, runWithin } from "./hook-timeout.ts";
import { type JobRegistry, registerJobs } from "./job-registry.ts";
import { type LoadFailure, LoadFailures } from "./load-failures.ts";
import type { Logger } from "./logger.ts";
import {
	type OperationRegistry,
	registerOperations,
} from "./operation-registry.ts";
import {
	catalogPlugins,
	type PluginDiscovery,
	type PluginPackage,
} from "./plugin-catalog.ts";
import type { ValidPlugin } from "./plugin-manifest.ts";
import { dependencyNotLoaded, resolvePlugins } from "./plugin-resolution.ts";
import { quote } from "./quote.ts";
import type {
	MigrationRun,
	SchemaMigrationOutcome,
	SchemaMigrations,
} from "./schema-migrations.ts";
import { pluginSchemaName, type SchemaName } from "./schema-name.ts";
import { systemFailureReason } from "./system-error.ts";

export type { HookTimeout } from "./hook-timeout.ts";
export type { LoadFailure } from "./load-failures.ts";
export type {
	PluginDiscovery,
	PluginPackage,
	UnreadablePackage,
} from "./plugin-catalog.ts";

export type CapabilityProviders = Readonly<Record<string, () => unknown>>;

export type MigrateSchemas = (
	schemas: readonly SchemaMigrations[],
) => Promise<MigrationRun>;

export type KernelOptions = {
	readonly discover: () => Promise<PluginDiscovery>;
	readonly enabledPlugins: readonly string[];
	readonly capabilityProviders: CapabilityProviders;
	readonly migrateSchemas: MigrateSchemas;
	readonly hookTimeout: HookTimeout;
	readonly stopSignal?: AbortSignal;
	readonly logger: Logger;
};

export type DeactivationOutcome = "clean" | "incomplete";

export type RunningPlugins = {
	readonly active: readonly string[];
	readonly failures: readonly LoadFailure[];
	readonly operations: OperationRegistry;
	readonly events: EventRegistry;
	readonly jobs: JobRegistry;
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

export async function startPlugins(
	options: KernelOptions,
): Promise<RunningPlugins> {
	const { logger } = options;
	const failures = new LoadFailures(logger);

	const packages = await discoverPackages(options);
	const { active, notActive } = await activateEnabledPlugins(
		packages,
		options,
		failures,
	);
	const events = registerEvents({ active, notActive });
	warnOfUndeclaredEvents(active, events, logger);
	const activeNames = active.map((plugin) => plugin.name);
	logger.info("plugins started", {
		active: activeNames,
		notLoaded: failures.all.map((failure) => failure.plugin),
	});

	let deactivation: Promise<DeactivationOutcome> | undefined;
	return {
		active: activeNames,
		failures: failures.all,
		operations: registerOperations([
			...CORE_OPERATIONS,
			...active.flatMap((plugin) => plugin.operations),
		]),
		events,
		jobs: registerJobs([
			...active.flatMap((plugin) => plugin.jobs),
			...CORE_JOBS,
		]),
		deactivate: () => {
			deactivation ??= deactivate(active, options);
			return deactivation;
		},
	};
}

function warnOfUndeclaredEvents(
	active: readonly ValidPlugin[],
	events: EventRegistry,
	logger: Logger,
): void {
	for (const { subscriptions } of active)
		for (const { subscriber, event } of subscriptions)
			if (events.findEvent(event) === undefined)
				logger.warn("subscribed event not declared", { subscriber, event });
}

type EnabledPlugins = {
	readonly active: readonly ValidPlugin[];
	readonly notActive: readonly ValidPlugin[];
};

async function activateEnabledPlugins(
	packages: readonly PluginPackage[],
	options: KernelOptions,
	failures: LoadFailures,
): Promise<EnabledPlugins> {
	const { logger, stopSignal } = options;
	const active: ValidPlugin[] = [];
	if (stopSignal?.aborted) {
		logger.info("plugin start stopped", {
			notActivated: options.enabledPlugins,
		});
		return { active, notActive: [] };
	}
	const { valid, activationOrder } = await resolvePlugins(
		catalogPlugins(
			packages,
			[DATABASE_CAPABILITY, ...Object.keys(options.capabilityProviders)],
			options.hookTimeout,
		),
		options.enabledPlugins,
		failures,
	);
	logger.info("plugins resolved", {
		activationOrder: activationOrder.map((plugin) => plugin.name),
	});
	const migrated = stopSignal?.aborted
		? activationOrder
		: await migratePluginSchemas(activationOrder, options, failures);
	for (const [position, plugin] of migrated.entries()) {
		if (stopSignal?.aborted) {
			logger.info("plugin start stopped", {
				notActivated: migrated
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
	return {
		active,
		notActive: valid.filter((plugin) => !active.includes(plugin)),
	};
}

async function migratePluginSchemas(
	plugins: readonly ValidPlugin[],
	{ migrateSchemas }: KernelOptions,
	failures: LoadFailures,
): Promise<readonly ValidPlugin[]> {
	const owners = new Map<SchemaName, ValidPlugin>();
	const schemas: SchemaMigrations[] = [];
	for (const plugin of plugins) {
		if (!plugin.capabilities.includes(DATABASE_CAPABILITY)) continue;
		try {
			const schema = pluginSchemaName(plugin.name);
			schemas.push({ schema, migrations: await plugin.loadMigrations() });
			owners.set(schema, plugin);
		} catch (error) {
			const thrown = describeThrown(error);
			failures.reject(migrationFailed(plugin, summarize(thrown), thrown));
		}
	}
	if (schemas.length > 0) {
		try {
			const run = await migrateSchemas(schemas);
			if (!run.stopped) rejectUnmigrated(owners, run.outcomes, failures);
		} catch (error) {
			const thrown = describeThrown(error);
			for (const owner of owners.values())
				failures.reject(migrationFailed(owner, summarize(thrown), thrown));
		}
	}
	return plugins.filter((plugin) => failures.find(plugin.name) === undefined);
}

function rejectUnmigrated(
	owners: ReadonlyMap<SchemaName, ValidPlugin>,
	outcomes: readonly SchemaMigrationOutcome[],
	failures: LoadFailures,
): void {
	const failed = new Map(
		outcomes.flatMap((outcome) =>
			outcome.migrated ? [] : [[outcome.schema, outcome] as const],
		),
	);
	for (const [schema, owner] of owners) {
		const failure = failed.get(schema);
		if (failure !== undefined)
			failures.reject(migrationFailed(owner, failure.detail, failure.error));
	}
}

function migrationFailed(
	plugin: ValidPlugin,
	cause: string,
	error: ThrownError | undefined,
): LoadFailure {
	const failure: LoadFailure = {
		plugin: plugin.name,
		reason: "migration_failed",
		detail: `plugin ${quote(plugin.name)} was not activated because its schema could not be migrated: ${cause}`,
	};
	return error === undefined ? failure : { ...failure, error };
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
		const reason = systemFailureReason(error);
		options.logger.error(
			"plugin discovery failed",
			reason === UNKNOWN_FAILURE_REASON
				? { reason, error: describeThrown(error) }
				: { reason },
		);
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
	const provision = provideContext(plugin, capabilityProviders);
	if (!provision.provided) return provision.failure;
	try {
		const outcome = await runWithin(
			() => plugin.activate(provision.context),
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

type ContextProvision =
	| { readonly provided: true; readonly context: PluginContext }
	| { readonly provided: false; readonly failure: LoadFailure };

function provideContext(
	plugin: ValidPlugin,
	providers: CapabilityProviders,
): ContextProvision {
	const granted = new Map<string, unknown>();
	for (const capability of plugin.capabilities) {
		try {
			granted.set(capability, provide(capability, plugin.name, providers));
		} catch (error) {
			const thrown = describeThrown(error);
			return {
				provided: false,
				failure: {
					plugin: plugin.name,
					reason: "capability_unavailable",
					detail: `plugin ${quote(plugin.name)} was not activated because the instance could not provide the capability ${quote(capability)} (${summarize(thrown)})`,
					error: thrown,
				},
			};
		}
	}
	return {
		provided: true,
		context: {
			capability: (name) => {
				if (!granted.has(name))
					throw new UndeclaredCapabilityError(plugin.name, name);
				return granted.get(name);
			},
		},
	};
}

function provide(
	capability: string,
	plugin: string,
	providers: CapabilityProviders,
): unknown {
	if (capability === DATABASE_CAPABILITY) {
		const database: DatabaseCapability = { schema: pluginSchemaName(plugin) };
		return database;
	}
	const event = subscribedEventOf(capability);
	if (event !== undefined) {
		const subscription: EventSubscriptionCapability = { event };
		return subscription;
	}
	return providers[capability]?.();
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
