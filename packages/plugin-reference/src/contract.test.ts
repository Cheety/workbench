import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_NAME = "@workbench/plugin-reference";
const PACKAGE_ROOT = join(import.meta.dir, "..");

// The workspace links no @workbench package into a shared node_modules, so a
// consumer is set up by hand: resolving from inside the plugin would only
// exercise the self-reference of its own package.
let consumer: string;

beforeAll(async () => {
	consumer = await mkdtemp(join(tmpdir(), "workbench-consumer-"));
	await mkdir(join(consumer, "node_modules", "@workbench"), {
		recursive: true,
	});
	await symlink(PACKAGE_ROOT, join(consumer, "node_modules", PACKAGE_NAME));
});

afterAll(async () => {
	await rm(consumer, { recursive: true, force: true });
});

describe("the contract of the reference plugin", () => {
	test("is published as the subpath export ./contract", () => {
		expect(Bun.resolveSync(`${PACKAGE_NAME}/contract`, consumer)).toStartWith(
			`${import.meta.dir}/contract/`,
		);
	});

	// Bun reports a subpath that is not exported exactly like a missing package
	// (ERR_MODULE_NOT_FOUND), so the test above, which resolves the contract
	// from the same consumer, is what rules out a missing package here.
	test("is the only export, so the inside of the plugin stays unreachable", () => {
		expect(() =>
			Bun.resolveSync(`${PACKAGE_NAME}/src/plugin.ts`, consumer),
		).toThrow(expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }));
	});
});
