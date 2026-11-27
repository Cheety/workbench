import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_NAME = "@workbench/plugin-reference";
const PACKAGE_ROOT = join(import.meta.dir, "..");

let consumerOutsideThePlugin: string;

beforeAll(async () => {
	consumerOutsideThePlugin = await mkdtemp(
		join(tmpdir(), "workbench-consumer-"),
	);
	await mkdir(join(consumerOutsideThePlugin, "node_modules", "@workbench"), {
		recursive: true,
	});
	await symlink(
		PACKAGE_ROOT,
		join(consumerOutsideThePlugin, "node_modules", PACKAGE_NAME),
	);
});

afterAll(async () => {
	await rm(consumerOutsideThePlugin, { recursive: true, force: true });
});

describe("the contract of the reference plugin", () => {
	test("is the only export, so the inside of the plugin stays unreachable", () => {
		expect(() =>
			Bun.resolveSync(
				`${PACKAGE_NAME}/src/plugin.ts`,
				consumerOutsideThePlugin,
			),
		).toThrow(expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }));
	});

	test("defines the event NoteCreated, so another plugin can subscribe to it", async () => {
		const contract: unknown = await import(
			Bun.resolveSync(`${PACKAGE_NAME}/contract`, consumerOutsideThePlugin)
		);

		expect(contract).toEqual(
			expect.objectContaining({
				noteCreated: expect.objectContaining({
					plugin: "reference",
					name: "NoteCreated",
					version: 1,
				}),
			}),
		);
	});
});
