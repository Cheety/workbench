import type { EventDefinition, EventSubscription } from "./event.ts";
import type { CronJobDefinition, JobDefinition } from "./job.ts";
import type { OperationDefinition } from "./operation.ts";

export * from "./event.ts";
export * from "./job.ts";
export * from "./operation.ts";

export const DATABASE_CAPABILITY = "database";

export type DatabaseCapability = {
	readonly schema: string;
};

export type PluginManifest = {
	readonly name: string;
	readonly requires?: Readonly<Record<string, string>>;
	readonly capabilities?: readonly string[];
};

export type PluginContext = {
	capability(name: string): unknown;
};

export type PluginDefinition = {
	readonly manifest: PluginManifest;
	readonly operations?: readonly OperationDefinition<unknown, unknown>[];
	readonly events?: readonly EventDefinition<unknown>[];
	readonly subscriptions?: readonly EventSubscription<unknown>[];
	readonly jobs?: readonly JobDefinition<unknown>[];
	readonly cronJobs?: readonly CronJobDefinition[];
	activate?(ctx: PluginContext): void | Promise<void>;
	deactivate?(): void | Promise<void>;
};

export function definePlugin(definition: PluginDefinition): PluginDefinition {
	return definition;
}
