import { describe, expect, test } from "bun:test";

describe("the contract of the reference plugin", () => {
	test("is published as the subpath export ./contract", () => {
		expect(
			Bun.resolveSync("@workbench/plugin-reference/contract", import.meta.dir),
		).toStartWith(`${import.meta.dir}/contract/`);
	});

	test("is the only export, so the inside of the plugin stays unreachable", () => {
		expect(() =>
			Bun.resolveSync(
				"@workbench/plugin-reference/src/plugin.ts",
				import.meta.dir,
			),
		).toThrow("Cannot find package '@workbench/plugin-reference'");
	});
});
