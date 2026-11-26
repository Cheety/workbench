/**
 * What a plugin states about itself before it runs. The version is not part of
 * the manifest: it is the `version` of the plugin package (ADR-0004).
 */
export type PluginManifest = {
	/**
	 * The name the instance config and other plugins refer to: lowercase
	 * letters, digits and hyphens, starting with a letter.
	 */
	readonly name: string;
	/** Required plugins by name, each with the SemVer range it must satisfy. */
	readonly requires?: Readonly<Record<string, string>>;
	/** Names of the capabilities the plugin needs; it receives no others. */
	readonly capabilities?: readonly string[];
};

export type PluginContext = {
	/**
	 * Returns a capability the manifest declares.
	 *
	 * @throws if the manifest does not declare `name`.
	 */
	capability(name: string): unknown;
};

export type PluginDefinition = {
	readonly manifest: PluginManifest;
	/** Called once at instance start, after every required plugin is active. */
	activate?(ctx: PluginContext): void | Promise<void>;
	/** Called once at instance shutdown, before any required plugin stops. */
	deactivate?(): void | Promise<void>;
};

/**
 * Declares a plugin; the result is the default export of the plugin entry
 * named in `workbench.plugin` of the package's `package.json`.
 *
 * It only anchors the type: the kernel validates what it loads, because a
 * loaded module is untyped at runtime.
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
	return definition;
}
