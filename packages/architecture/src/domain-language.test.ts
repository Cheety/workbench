import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findDomainLanguage } from "./domain-language.ts";

const temporaryDirectories: string[] = [];

afterAll(async () => {
	await Promise.all(
		temporaryDirectories.map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

async function coreWith(
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "workbench-core-"));
	temporaryDirectories.push(directory);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(directory, path)), { recursive: true });
		await writeFile(join(directory, path), content);
	}
	return directory;
}

describe("domain language in the core", () => {
	test.each([
		["export type KanbanColumn = { id: string };", "kanban"],
		["const whiteboard_shapes = [];", "whiteboard"],
		['log.info("chat-room opened");', "chat"],
		["CREATE TABLE core.sprint (id uuid PRIMARY KEY);", "sprint"],
		["CREATE TABLE core.notes (id uuid PRIMARY KEY);", "note"],
		["export function closeTickets(): void {}", "ticket"],
		["export type IssueTrackerSettings = {};", "issue tracker"],
		["const AGENT_FACTORY_QUEUE = 'jobs';", "agent factory"],
		["export function listAgentFactories(): void {}", "agent factory"],
		["const swimlanes = [];", "swimlane"],
		['router.get("/graph-views", list);', "graph view"],
	])("is found in %s", async (source, term) => {
		const core = await coreWith({ "src/columns.ts": source });

		expect(await findDomainLanguage(core)).toEqual([
			{ file: "src/columns.ts", term },
		]);
	});

	test.each([
		["export class ConfigIssue {}"],
		["throw new InvalidConfigError(parsed.error.issues);"],
		["const tracker = new MigrationTracker();"],
	])("is not found in the generic words of %s", async (source) => {
		const core = await coreWith({ "src/config.ts": source });

		expect(await findDomainLanguage(core)).toEqual([]);
	});

	test("is not looked for in tests, whose fixture plugins have domains of their own", async () => {
		const core = await coreWith({
			"src/kernel.test.ts": 'const plugin = { name: "notes" };',
		});

		expect(await findDomainLanguage(core)).toEqual([]);
	});

	test("is not looked for in installed dependencies", async () => {
		const core = await coreWith({
			"node_modules/vendor/index.js": "export const note = '';",
		});

		expect(await findDomainLanguage(core)).toEqual([]);
	});
});

describe("the packages of this repository", () => {
	test.each([["core"], ["sdk"]])(
		"%s speaks no domain language besides the workspace",
		async (packageDirectory) => {
			expect(
				await findDomainLanguage(
					join(import.meta.dir, "..", "..", packageDirectory),
				),
			).toEqual([]);
		},
	);
});
