const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

export function isPluginName(value: unknown): value is string {
	return typeof value === "string" && PLUGIN_NAME.test(value);
}
