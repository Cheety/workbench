import { quote } from "./quote.ts";

declare const schemaNameBrand: unique symbol;

export type SchemaName = string & { readonly [schemaNameBrand]: true };

const MAX_SCHEMA_NAME_LENGTH = 63;

const PLUGIN_SCHEMA_PREFIX = "plugin_";

export const MAX_PLUGIN_NAME_LENGTH =
	MAX_SCHEMA_NAME_LENGTH - PLUGIN_SCHEMA_PREFIX.length;

export const SCHEMA_NAME_PATTERN = `^[a-z][a-z0-9_]{0,${MAX_SCHEMA_NAME_LENGTH - 1}}$`;

const SCHEMA_NAME = new RegExp(SCHEMA_NAME_PATTERN);

export class InvalidSchemaNameError extends Error {
	constructor(value: string) {
		super(
			`schema name ${quote(value)} must consist of at most ${MAX_SCHEMA_NAME_LENGTH} lowercase letters, digits and underscores and start with a letter`,
		);
		this.name = "InvalidSchemaNameError";
	}
}

export function schemaName(value: string): SchemaName {
	if (!SCHEMA_NAME.test(value)) throw new InvalidSchemaNameError(value);
	return value as SchemaName;
}

export const CORE_SCHEMA = schemaName("core");

export function pluginSchemaName(plugin: string): SchemaName {
	return schemaName(`${PLUGIN_SCHEMA_PREFIX}${plugin.replaceAll("-", "_")}`);
}
