/**
 * What a plugin states about itself before it runs. The version is not part of
 * the manifest: it is the `version` of the plugin package (ADR-0007).
 */
export type PluginManifest = {
	/**
	 * The name the instance config and other plugins refer to: lowercase
	 * letters, digits and hyphens, starting with a letter. It must equal
	 * `workbench.plugin.name` of the package's `package.json`.
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
	/**
	 * Called once at instance start, after every required plugin is active.
	 *
	 * If it throws, rejects or does not settle within the instance's hook
	 * timeout, the plugin counts as not loaded and `deactivate` is never called
	 * for it. It must therefore release whatever it acquired before it fails;
	 * the kernel cannot tell how far it got.
	 */
	activate?(ctx: PluginContext): void | Promise<void>;
	/**
	 * Called once at instance shutdown, before any required plugin stops, and
	 * only if `activate` succeeded. It has the instance's hook timeout to
	 * settle; after that the instance shuts down without waiting for it.
	 */
	deactivate?(): void | Promise<void>;
};

/**
 * Declares a plugin; the result is the default export of the plugin entry
 * named in `workbench.plugin.entry` of the package's `package.json`.
 *
 * It only anchors the type: the kernel validates what it loads, because a
 * loaded module is untyped at runtime.
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
	return definition;
}
