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
	activate?(ctx: PluginContext): void | Promise<void>;
	deactivate?(): void | Promise<void>;
};

export function definePlugin(definition: PluginDefinition): PluginDefinition {
	return definition;
}
