import { quote } from "./quote.ts";
import {
	CORE_SCHEMA,
	pluginSchemaName,
	type SchemaName,
} from "./schema-name.ts";

export type Owner =
	| { readonly kind: "core" }
	| { readonly kind: "plugin"; readonly name: string };

export const CORE_OWNER: Owner = { kind: "core" };

export const CORE_OWNER_NAME = "core";

export function pluginOwner(name: string): Owner {
	return { kind: "plugin", name };
}

export function ownerName(owner: Owner): string {
	switch (owner.kind) {
		case "core":
			return CORE_OWNER_NAME;
		case "plugin":
			return owner.name;
	}
}

export function describeOwner(owner: Owner): string {
	switch (owner.kind) {
		case "core":
			return "the core";
		case "plugin":
			return `plugin ${quote(owner.name)}`;
	}
}

export function schemaOf(owner: Owner): SchemaName {
	switch (owner.kind) {
		case "core":
			return CORE_SCHEMA;
		case "plugin":
			return pluginSchemaName(owner.name);
	}
}
