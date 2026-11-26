import { describe, expect, test } from "bun:test";
import {
	InvalidSchemaNameError,
	pluginSchemaName,
	schemaName,
} from "./schema-name.ts";

describe("schema names", () => {
	test.each([
		["longer than Postgres keeps", `plugin_${"a".repeat(57)}`],
		["not a plain lowercase identifier", 'plugin_x"; DROP SCHEMA core; --'],
		["starting with a digit", "1plugin"],
	])("reject a name %s", (_, value) => {
		expect(() => schemaName(value)).toThrow(new InvalidSchemaNameError(value));
	});

	test("accept a name of 63 characters", () => {
		const longest = `plugin_${"a".repeat(56)}`;

		expect(String(schemaName(longest))).toBe(longest);
	});

	test("name the schema of a plugin after the plugin, with underscores for hyphens", () => {
		expect(pluginSchemaName("sticky-notes")).toBe(
			schemaName("plugin_sticky_notes"),
		);
	});
});
