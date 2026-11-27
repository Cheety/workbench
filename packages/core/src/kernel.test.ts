import { afterEach, describe, expect, test } from "bun:test";
import {
	defineEvent,
	defineEventSubscription,
	defineOperation,
	definePlugin,
	eventSubscriptionCapability,
	type PluginContext,
	type PluginDefinition,
} from "@workbench/sdk";
import { z } from "zod";
import { Secret } from "./config.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import {
	type CapabilityProviders,
	type HookTimeout,
	type LoadFailure,
	type MigrateSchemas,
	type PluginPackage,
	startPlugins,
	UndeclaredCapabilityError,
	type UnreadablePackage,
} from "./kernel.ts";
import {
	type Migration,
	type MigrationRunner,
	migrateSchemas,
} from "./schema-migrations.ts";
import { schemaName } from "./schema-name.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	PostgresGate,
} from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";

function packageOf(
	definition: PluginDefinition,
	version = "1.0.0",
): PluginPackage {
	return {
		packageName: `@workbench/plugin-${definition.manifest.name}`,
		pluginName: definition.manifest.name,
		version,
		loadDefinition: async () => definition,
	};
}

const databases: FreshDatabase[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) await database.drop();
});

function migratingInto(
	postgres: { readonly url: string },
	stopSignal: AbortSignal = new AbortController().signal,
): MigrateSchemas {
	const runner: MigrationRunner = {
		databaseUrl: new Secret(postgres.url),
		connectionTimeoutMs: 2_000,
		statementTimeoutMs: 5_000,
		lockRetryDelayMs: () => 10,
		setTimer: setSystemTimer,
		logger: recordingLogger().logger,
	};
	return (schemas) => migrateSchemas(runner, schemas, stopSignal);
}

async function pluginSchemasIn(database: FreshDatabase): Promise<string[]> {
	const rows = await database.sql<{ schema_name: string }[]>`
		SELECT schema_name FROM information_schema.schemata
		WHERE starts_with(schema_name, 'plugin_') ORDER BY schema_name`;
	return rows.map((row) => row.schema_name);
}

type AppliedMigration = { readonly schema: string; readonly migration: string };

async function appliedMigrationsIn(
	database: FreshDatabase,
): Promise<AppliedMigration[]> {
	const rows = await database.sql<AppliedMigration[]>`
		SELECT schema_name AS schema, migration FROM core.migrations
		ORDER BY schema_name, migration`;
	return [...rows];
}

async function freshDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	databases.push(database);
	return database;
}

function migratingIntoFreshDatabase(): MigrateSchemas {
	return async (schemas) => migratingInto(await freshDatabase())(schemas);
}

function withMigrations(
	pluginPackage: PluginPackage,
	migrations: readonly Migration[],
): PluginPackage {
	return { ...pluginPackage, loadMigrations: async () => migrations };
}

const CREATE_NOTES: Migration = {
	name: "0001_create_notes.sql",
	sql: "CREATE TABLE notes (id bigint PRIMARY KEY);",
};

const BROKEN_CREATE_NOTES: Migration = {
	name: "0001_create_notes.sql",
	sql: "CREATE TABLE notes (id bigint PRIMARY KEY",
};

type Scenario = {
	readonly packages: readonly PluginPackage[];
	readonly unreadable?: readonly UnreadablePackage[];
	readonly enabledPlugins: readonly string[];
	readonly capabilityProviders?: CapabilityProviders;
	readonly migrateSchemas?: MigrateSchemas;
	readonly hookTimeout?: HookTimeout;
	readonly stopSignal?: AbortSignal;
};

const NEVER_EXPIRING: HookTimeout = { ms: 10_000, setTimer: () => () => {} };

function manualTimers() {
	const delaysMs: number[] = [];
	const pending = new Set<() => void>();
	let announce: ((expire: () => void) => void) | undefined;
	let latest: (() => void) | undefined;
	const setTimer: HookTimeout["setTimer"] = (expire, delayMs) => {
		delaysMs.push(delayMs);
		const timer = () => {
			if (pending.delete(timer)) expire();
		};
		pending.add(timer);
		latest = timer;
		announce?.(timer);
		announce = undefined;
		return () => {
			pending.delete(timer);
		};
	};
	return {
		setTimer,
		delaysMs,
		pending: () => pending.size,
		expireLatest: () => {
			if (latest === undefined || !pending.has(latest))
				throw new Error("the latest timer is not pending");
			latest();
		},
		next: () =>
			new Promise<() => void>((resolve) => {
				announce = resolve;
			}),
	};
}

function hanging(): Promise<void> {
	return new Promise(() => {});
}

function settled(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function byPlugin(failures: readonly LoadFailure[]): LoadFailure[] {
	return [...failures].sort((a, b) => a.plugin.localeCompare(b.plugin));
}

async function start(scenario: Scenario) {
	const { logger, entries } = recordingLogger();
	const plugins = await startPlugins({
		discover: async () => ({
			packages: scenario.packages,
			unreadable: scenario.unreadable ?? [],
		}),
		enabledPlugins: scenario.enabledPlugins,
		capabilityProviders: scenario.capabilityProviders ?? {},
		migrateSchemas: scenario.migrateSchemas ?? migratingIntoFreshDatabase(),
		hookTimeout: scenario.hookTimeout ?? NEVER_EXPIRING,
		...(scenario.stopSignal === undefined
			? {}
			: { stopSignal: scenario.stopSignal }),
		logger,
	});
	return { plugins, entries };
}

function recordingPlugin(
	journal: string[],
	manifest: PluginDefinition["manifest"],
): PluginDefinition {
	return definePlugin({
		manifest,
		activate: () => {
			journal.push(`activate ${manifest.name}`);
		},
		deactivate: () => {
			journal.push(`deactivate ${manifest.name}`);
		},
	});
}

describe("plugin kernel", () => {
	test("activates a plugin the instance config enables and no other", async () => {
		const journal: string[] = [];

		const { plugins } = await start({
			packages: [
				packageOf(recordingPlugin(journal, { name: "notes" })),
				packageOf(recordingPlugin(journal, { name: "board" })),
			],
			enabledPlugins: ["notes"],
		});

		expect(plugins.active).toEqual(["notes"]);
		expect(plugins.failures).toEqual([]);
		expect(journal).toEqual(["activate notes"]);
	});

	test("activates required plugins first and deactivates in reverse order, only on shutdown", async () => {
		const journal: string[] = [];
		const { plugins } = await start({
			packages: [
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
				packageOf(recordingPlugin(journal, { name: "notes" }), "1.4.0"),
			],
			enabledPlugins: ["board", "notes"],
		});
		const journalAtStart = [...journal];

		const outcome = await plugins.deactivate();

		expect(journalAtStart).toEqual(["activate notes", "activate board"]);
		expect(journal).toEqual([
			"activate notes",
			"activate board",
			"deactivate board",
			"deactivate notes",
		]);
		expect(outcome).toBe("clean");
	});

	test("does not load a plugin with an invalid manifest and says what is wrong with it", async () => {
		const { plugins, entries } = await start({
			packages: [
				{
					packageName: "@workbench/plugin-board",
					pluginName: "board",
					version: "1.0.0",
					loadDefinition: async () => ({
						manifest: { name: "board", requires: { notes: "not a range" } },
						activate: "soon",
					}),
				},
			],
			enabledPlugins: ["board"],
		});

		const failure: LoadFailure = {
			plugin: "board",
			reason: "invalid_manifest",
			detail:
				'plugin package "@workbench/plugin-board" has an invalid manifest: manifest.requires.notes must be a SemVer range such as "^1.2.0"; activate must be a function',
		};
		expect(plugins.active).toEqual([]);
		expect(plugins.failures).toEqual([failure]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin not loaded",
				...failure,
			}),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				message: "plugins started",
				active: [],
				notLoaded: ["board"],
			}),
		);
	});

	test("does not load a plugin named core, whose operations would pass for those of the core", async () => {
		const { plugins } = await start({
			packages: [packageOf(definePlugin({ manifest: { name: "core" } }))],
			enabledPlugins: ["core"],
		});

		expect(plugins.active).toEqual([]);
		expect(plugins.failures).toEqual([
			{
				plugin: "core",
				reason: "invalid_manifest",
				detail:
					'plugin package "@workbench/plugin-core" has an invalid manifest: manifest.name must not be "core", the name under which the core offers its own operations',
			},
		]);
	});

	test.each([
		[
			"a name that is not a plugin name",
			{ manifest: { name: "Not A Name" } },
			"1.0.0",
			"manifest.name must consist of lowercase letters, digits and hyphens and start with a letter",
		],
		[
			"no manifest",
			{ activate: () => {} },
			"1.0.0",
			"manifest must be an object",
		],
		[
			"no default export",
			undefined,
			"1.0.0",
			"default export must be a plugin definition",
		],
		[
			"a name other than the one package.json declares",
			{ manifest: { name: "notes" } },
			"1.0.0",
			'manifest.name "notes" differs from the plugin name "board" that package.json declares',
		],
		[
			"a required plugin that is not a plugin name",
			{ manifest: { name: "board", requires: { "Not A Name": "^1.0.0" } } },
			"1.0.0",
			'manifest.requires names "Not A Name", which is not a plugin name',
		],
		[
			"a capability the instance does not offer",
			{ manifest: { name: "board", capabilities: ["teleport"] } },
			"1.0.0",
			'manifest.capabilities names "teleport", which this instance does not offer',
		],
		[
			"a package version that is not SemVer",
			{ manifest: { name: "board" } },
			"one",
			"package.json version must be a SemVer version",
		],
		[
			"no package version",
			{ manifest: { name: "board" } },
			undefined,
			"package.json version must be a SemVer version",
		],
	])(
		"rejects a manifest with %s",
		async (_case, definition, version, problem) => {
			const { plugins } = await start({
				packages: [
					{
						packageName: "@workbench/plugin-board",
						pluginName: "board",
						version,
						loadDefinition: async () => definition,
					},
				],
				enabledPlugins: ["board"],
			});

			expect(plugins.failures).toEqual([
				expect.objectContaining({
					plugin: "board",
					reason: "invalid_manifest",
					detail: `plugin package "@workbench/plugin-board" has an invalid manifest: ${problem}`,
				}),
			]);
		},
	);

	test("does not load the entry of a plugin the instance config does not enable", async () => {
		const loaded: string[] = [];
		const tracked = (name: string): PluginPackage => ({
			...packageOf(definePlugin({ manifest: { name } })),
			loadDefinition: async () => {
				loaded.push(name);
				return definePlugin({ manifest: { name } });
			},
		});

		const { plugins } = await start({
			packages: [tracked("board"), tracked("notes")],
			enabledPlugins: ["notes"],
		});

		expect(loaded).toEqual(["notes"]);
		expect(plugins.active).toEqual(["notes"]);
	});

	test("reports no load failure for a broken plugin the instance config does not enable", async () => {
		const { plugins, entries } = await start({
			packages: [
				packageOf(definePlugin({ manifest: { name: "board" } }), "one"),
				packageOf(definePlugin({ manifest: { name: "notes" } })),
			],
			enabledPlugins: ["notes"],
		});

		expect(plugins.failures).toEqual([]);
		expect(entries.map((entry) => entry.message)).not.toContain(
			"plugin not loaded",
		);
	});

	test("keeps a plugin apart from a plugin package of the same name", async () => {
		const { plugins } = await start({
			packages: [
				{
					packageName: "notes",
					pluginName: "board",
					version: "1.0.0",
					loadDefinition: async () => ({ manifest: { name: 7 } }),
				},
				packageOf(definePlugin({ manifest: { name: "notes" } })),
			],
			enabledPlugins: ["board", "notes"],
		});

		expect(plugins.failures.map((failure) => failure.plugin)).toEqual([
			"board",
		]);
		expect(plugins.active).toEqual(["notes"]);
	});

	test("tells the operator what a plugin entry threw when it could not be loaded", async () => {
		const { plugins, entries } = await start({
			packages: [
				{
					packageName: "@workbench/plugin-board",
					pluginName: "board",
					version: "1.0.0",
					loadDefinition: () =>
						Promise.reject(new SyntaxError("Unexpected token '}'")),
				},
			],
			enabledPlugins: ["board"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "board",
				reason: "invalid_manifest",
				detail:
					"plugin package \"@workbench/plugin-board\" has an invalid manifest: plugin entry failed to load (SyntaxError: Unexpected token '}')",
				error: {
					name: "SyntaxError",
					message: "Unexpected token '}'",
					stack: expect.stringContaining("kernel.test.ts"),
				},
			},
		]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin not loaded",
				plugin: "board",
				error: expect.objectContaining({
					name: "SyntaxError",
					message: "Unexpected token '}'",
					stack: expect.stringContaining("kernel.test.ts"),
				}),
			}),
		);
	});

	test.each(["^1.2.0", "~1.4", ">=1.0.0 <2.0.0", "1.x || 2.x", "*", "1.4.0"])(
		"accepts the SemVer range %s in requires",
		async (range) => {
			const { plugins } = await start({
				packages: [
					packageOf(
						definePlugin({
							manifest: { name: "board", requires: { notes: range } },
						}),
					),
					packageOf(definePlugin({ manifest: { name: "notes" } }), "1.4.0"),
				],
				enabledPlugins: ["board", "notes"],
			});

			expect(plugins.active).toEqual(["notes", "board"]);
		},
	);

	test.each([
		">= 1.0.0",
		"  ^1.2.0  ",
		"1.x||2.x",
		">=1.0.0   <2.0.0",
		"~ 1.4 || >2",
		"<= 1.4.0",
		"1 || 2 || X",
	])("accepts the SemVer range %p with optional whitespace", async (range) => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "board", requires: { notes: range } },
					}),
				),
				packageOf(definePlugin({ manifest: { name: "notes" } }), "1.4.0"),
			],
			enabledPlugins: ["board", "notes"],
		});

		expect(plugins.failures).toEqual([]);
	});

	test.each([
		["longer than 256 characters", `1${" 1".repeat(128)}`],
		[
			"crafted to make a backtracking matcher run forever",
			`1${"  1".repeat(40)}!`,
		],
	])("rejects a requires range %s", async (_case, range) => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "board", requires: { notes: range } },
					}),
				),
				packageOf(definePlugin({ manifest: { name: "notes" } }), "1.4.0"),
			],
			enabledPlugins: ["board", "notes"],
		});

		expect(plugins.failures).toEqual([
			expect.objectContaining({
				plugin: "board",
				reason: "invalid_manifest",
				detail:
					'plugin package "@workbench/plugin-board" has an invalid manifest: manifest.requires.notes must be a SemVer range such as "^1.2.0"',
			}),
		]);
	});

	test("does not load a plugin that requires a plugin no plugin package provides", async () => {
		const journal: string[] = [];

		const { plugins } = await start({
			packages: [
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
			],
			enabledPlugins: ["board"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "board",
				reason: "missing_dependency",
				detail:
					'plugin "board" requires plugin "notes" (^1.0.0), which no plugin package provides',
			},
		]);
		expect(plugins.active).toEqual([]);
		expect(journal).toEqual([]);
	});

	test("does not activate a required plugin the instance config leaves out", async () => {
		const journal: string[] = [];

		const { plugins } = await start({
			packages: [
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
				packageOf(recordingPlugin(journal, { name: "notes" })),
			],
			enabledPlugins: ["board"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "board",
				reason: "missing_dependency",
				detail:
					'plugin "board" requires plugin "notes" (^1.0.0), which is not enabled in the instance config',
			},
		]);
		expect(journal).toEqual([]);
	});

	test("does not load a plugin whose required plugin has an unsuitable version", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "board", requires: { notes: "^2.0.0" } },
					}),
				),
				packageOf(definePlugin({ manifest: { name: "notes" } }), "1.4.0"),
			],
			enabledPlugins: ["board", "notes"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "board",
				reason: "version_mismatch",
				detail:
					'plugin "board" requires plugin "notes" in a version matching ^2.0.0, but its version is 1.4.0',
			},
		]);
		expect(plugins.active).toEqual(["notes"]);
	});

	test("does not load plugins that depend on a plugin that was not loaded and names the cause", async () => {
		const journal: string[] = [];

		const { plugins } = await start({
			packages: [
				packageOf(
					recordingPlugin(journal, {
						name: "cards",
						requires: { board: "^1.0.0" },
					}),
				),
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^2.0.0" },
					}),
				),
				packageOf(recordingPlugin(journal, { name: "notes" }), "1.4.0"),
			],
			enabledPlugins: ["cards", "board", "notes"],
		});

		expect(plugins.failures).toContainEqual({
			plugin: "cards",
			reason: "dependency_not_loaded",
			detail:
				'plugin "cards" requires plugin "board", which was not loaded: plugin "board" requires plugin "notes" in a version matching ^2.0.0, but its version is 1.4.0',
		});
		expect(plugins.failures.map((failure) => failure.plugin)).toEqual([
			"board",
			"cards",
		]);
		expect(journal).toEqual(["activate notes"]);
	});

	test("does not load a plugin that requires a plugin with an invalid manifest", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "board", requires: { notes: "^1.0.0" } },
					}),
				),
				packageOf(definePlugin({ manifest: { name: "notes" } }), "one"),
			],
			enabledPlugins: ["board", "notes"],
		});

		expect(plugins.failures).toContainEqual({
			plugin: "board",
			reason: "dependency_not_loaded",
			detail:
				'plugin "board" requires plugin "notes", which was not loaded: plugin package "@workbench/plugin-notes" has an invalid manifest: package.json version must be a SemVer version',
		});
		expect(plugins.active).toEqual([]);
	});

	test("reports an enabled plugin that no plugin package provides", async () => {
		const { plugins } = await start({
			packages: [packageOf(definePlugin({ manifest: { name: "notes" } }))],
			enabledPlugins: ["ghost", "notes"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "ghost",
				reason: "unknown_plugin",
				detail:
					'plugin "ghost" is enabled in the instance config, but no plugin package provides it',
			},
		]);
		expect(plugins.active).toEqual(["notes"]);
	});

	test("does not load plugins that require each other", async () => {
		const journal: string[] = [];

		const { plugins } = await start({
			packages: [
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
				packageOf(
					recordingPlugin(journal, {
						name: "notes",
						requires: { board: "^1.0.0" },
					}),
				),
			],
			enabledPlugins: ["board", "notes"],
		});

		expect(byPlugin(plugins.failures)).toEqual([
			{
				plugin: "board",
				reason: "dependency_cycle",
				detail:
					'plugin "board" is part of a dependency cycle: board -> notes -> board',
			},
			{
				plugin: "notes",
				reason: "dependency_cycle",
				detail:
					'plugin "notes" is part of a dependency cycle: board -> notes -> board',
			},
		]);
		expect(journal).toEqual([]);
	});

	test("reports the cycle for each of its plugins and the cause for a plugin that requires one of them", async () => {
		const requiring = (name: string, required: string): PluginPackage =>
			packageOf(
				definePlugin({ manifest: { name, requires: { [required]: "*" } } }),
			);

		const { plugins } = await start({
			packages: [
				requiring("cards", "board"),
				requiring("board", "notes"),
				requiring("notes", "tags"),
				requiring("tags", "board"),
			],
			enabledPlugins: ["cards", "board", "notes", "tags"],
		});

		expect(
			byPlugin(plugins.failures).map(({ plugin, reason }) => ({
				plugin,
				reason,
			})),
		).toEqual([
			{ plugin: "board", reason: "dependency_cycle" },
			{ plugin: "cards", reason: "dependency_not_loaded" },
			{ plugin: "notes", reason: "dependency_cycle" },
			{ plugin: "tags", reason: "dependency_cycle" },
		]);
		expect(
			plugins.failures.find(({ plugin }) => plugin === "board")?.detail,
		).toBe(
			'plugin "board" is part of a dependency cycle: board -> notes -> tags -> board',
		);
	});

	test.each([
		[
			"was rejected for another cycle first",
			{ cards: ["board"], board: ["notes", "cards"], notes: ["board"] },
			[
				{ plugin: "notes", cycle: "notes -> board -> notes" },
				{ plugin: "board", cycle: "cards -> board -> cards" },
				{ plugin: "cards", cycle: "cards -> board -> cards" },
			],
		],
		[
			"was rejected before the plugin was reached",
			{ cards: ["board", "notes"], board: ["cards"], notes: ["board"] },
			[
				{ plugin: "board", cycle: "cards -> board -> cards" },
				{ plugin: "cards", cycle: "cards -> board -> cards" },
				{ plugin: "notes", cycle: "notes -> board -> cards -> notes" },
			],
		],
	])(
		"reports the cycle for a plugin of a cycle whose required plugin %s",
		async (_case, requirements, cycles) => {
			const { plugins } = await start({
				packages: Object.entries(requirements).map(([name, required]) =>
					packageOf(
						definePlugin({
							manifest: {
								name,
								requires: Object.fromEntries(
									required.map((requiredName) => [requiredName, "*"]),
								),
							},
						}),
					),
				),
				enabledPlugins: Object.keys(requirements),
			});

			expect(byPlugin(plugins.failures)).toEqual(
				byPlugin(
					cycles.map(({ plugin, cycle }) => ({
						plugin,
						reason: "dependency_cycle",
						detail: `plugin "${plugin}" is part of a dependency cycle: ${cycle}`,
					})),
				),
			);
		},
	);

	test("loads none of several plugin packages that declare the same plugin name", async () => {
		const journal: string[] = [];

		const { plugins } = await start({
			packages: [
				packageOf(recordingPlugin(journal, { name: "notes" })),
				{
					...packageOf(recordingPlugin(journal, { name: "notes" })),
					packageName: "@workbench/plugin-notes-copy",
				},
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
			],
			enabledPlugins: ["notes", "board"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "notes",
				reason: "duplicate_plugin",
				detail:
					'plugin "notes" is declared by several plugin packages: "@workbench/plugin-notes", "@workbench/plugin-notes-copy"',
			},
			expect.objectContaining({
				plugin: "board",
				reason: "dependency_not_loaded",
			}),
		]);
		expect(journal).toEqual([]);
	});

	test("ignores plugin packages that declare the same plugin name while the instance config does not enable it", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(definePlugin({ manifest: { name: "notes" } })),
				{
					...packageOf(definePlugin({ manifest: { name: "notes" } })),
					packageName: "@workbench/plugin-notes-copy",
				},
				packageOf(definePlugin({ manifest: { name: "board" } })),
			],
			enabledPlugins: ["board"],
		});

		expect(plugins.failures).toEqual([]);
		expect(plugins.active).toEqual(["board"]);
	});

	test("does not load a plugin whose activation fails, nor the plugins requiring it", async () => {
		const journal: string[] = [];

		const { plugins, entries } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "notes" },
						activate: () => {
							throw new TypeError("notes table is missing");
						},
						deactivate: () => {
							journal.push("deactivate notes");
						},
					}),
				),
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
				packageOf(recordingPlugin(journal, { name: "cards" })),
			],
			enabledPlugins: ["board", "notes", "cards"],
		});
		await plugins.deactivate();

		expect(plugins.failures).toEqual([
			{
				plugin: "notes",
				reason: "activation_failed",
				detail:
					'plugin "notes" failed to activate (TypeError: notes table is missing)',
				error: {
					name: "TypeError",
					message: "notes table is missing",
					stack: expect.stringContaining("kernel.test.ts"),
				},
			},
			{
				plugin: "board",
				reason: "dependency_not_loaded",
				detail:
					'plugin "board" requires plugin "notes", which was not loaded: plugin "notes" failed to activate (TypeError: notes table is missing)',
			},
		]);
		expect(plugins.active).toEqual(["cards"]);
		expect(journal).toEqual(["activate cards", "deactivate cards"]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				message: "plugin not loaded",
				plugin: "notes",
				error: expect.objectContaining({ message: "notes table is missing" }),
			}),
		);
	});

	test("leaves a plugin that failed midway through activation to clean up after itself", async () => {
		const journal: string[] = [];
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "notes" },
						activate: () => {
							journal.push("notes opened its index");
							throw new Error("notes table is missing");
						},
						deactivate: () => {
							journal.push("deactivate notes");
						},
					}),
				),
			],
			enabledPlugins: ["notes"],
		});

		await plugins.deactivate();

		expect(plugins.active).toEqual([]);
		expect(journal).toEqual(["notes opened its index"]);
	});

	test("reports what a plugin threw even when it is not an Error", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "notes" },
						activate: () => Promise.reject("notes table is missing"),
					}),
				),
			],
			enabledPlugins: ["notes"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "notes",
				reason: "activation_failed",
				detail:
					'plugin "notes" failed to activate (unknown: notes table is missing)',
				error: { name: "unknown", message: "notes table is missing" },
			},
		]);
	});

	test("gives up on a plugin that does not finish activating and starts the others", async () => {
		const journal: string[] = [];
		const timers = manualTimers();
		const activating = Promise.withResolvers<void>();

		const starting = start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "notes" },
						activate: () => {
							activating.resolve();
							return hanging();
						},
						deactivate: () => {
							journal.push("deactivate notes");
						},
					}),
				),
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
				packageOf(recordingPlugin(journal, { name: "cards" })),
			],
			enabledPlugins: ["notes", "board", "cards"],
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});
		await activating.promise;
		timers.expireLatest();
		const { plugins } = await starting;
		await plugins.deactivate();

		expect(plugins.failures).toEqual([
			{
				plugin: "notes",
				reason: "activation_timed_out",
				detail: 'plugin "notes" did not finish activating within 5000 ms',
			},
			{
				plugin: "board",
				reason: "dependency_not_loaded",
				detail:
					'plugin "board" requires plugin "notes", which was not loaded: plugin "notes" did not finish activating within 5000 ms',
			},
		]);
		expect(plugins.active).toEqual(["cards"]);
		expect(journal).toEqual(["activate cards", "deactivate cards"]);
	});

	test("ignores an activation that fails after it has timed out", async () => {
		const timers = manualTimers();
		const activating = Promise.withResolvers<void>();
		const activation = Promise.withResolvers<void>();

		const starting = start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "notes" },
						activate: () => {
							activating.resolve();
							return activation.promise;
						},
					}),
				),
			],
			enabledPlugins: ["notes"],
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});
		await activating.promise;
		timers.expireLatest();
		const { plugins, entries } = await starting;
		activation.reject(new Error("too late"));
		await settled();

		expect(plugins.failures.map((failure) => failure.reason)).toEqual([
			"activation_timed_out",
		]);
		expect(JSON.stringify(entries)).not.toContain("too late");
	});

	test("gives up on a plugin that does not finish deactivating and deactivates the others", async () => {
		const journal: string[] = [];
		const timers = manualTimers();
		const { plugins, entries } = await start({
			packages: [
				packageOf(recordingPlugin(journal, { name: "notes" })),
				packageOf(
					definePlugin({ manifest: { name: "board" }, deactivate: hanging }),
				),
			],
			enabledPlugins: ["notes", "board"],
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});
		const timeUp = timers.next();

		const deactivating = plugins.deactivate();
		(await timeUp)();
		const outcome = await deactivating;

		expect(outcome).toBe("incomplete");
		expect(journal).toEqual(["activate notes", "deactivate notes"]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin deactivation timed out",
				plugin: "board",
				timeoutMs: 5000,
			}),
		);
	});

	test("stops the clock of every load, activation and deactivation that finishes in time", async () => {
		const timers = manualTimers();
		const { plugins } = await start({
			packages: [
				packageOf(definePlugin({ manifest: { name: "notes" } })),
				packageOf(definePlugin({ manifest: { name: "board" } })),
			],
			enabledPlugins: ["notes", "board"],
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});

		await plugins.deactivate();

		expect(new Set(timers.delaysMs)).toEqual(new Set([5000]));
		expect(timers.pending()).toBe(0);
	});

	test("hands a plugin the capabilities its manifest declares and no others", async () => {
		const clock = { now: () => new Date("2026-11-26T08:00:00.000Z") };
		const provided: string[] = [];
		const contexts = new Map<string, PluginContext>();
		const capturing = (
			manifest: PluginDefinition["manifest"],
		): PluginDefinition =>
			definePlugin({
				manifest,
				activate: (ctx) => {
					contexts.set(manifest.name, ctx);
				},
			});

		await start({
			packages: [
				packageOf(capturing({ name: "notes", capabilities: ["clock"] })),
				packageOf(capturing({ name: "board" })),
			],
			enabledPlugins: ["notes", "board"],
			capabilityProviders: {
				clock: () => {
					provided.push("clock");
					return clock;
				},
				vault: () => {
					provided.push("vault");
					return {};
				},
			},
		});

		expect(contexts.get("notes")?.capability("clock")).toBe(clock);
		expect(() => contexts.get("notes")?.capability("vault")).toThrow(
			new UndeclaredCapabilityError("notes", "vault"),
		);
		expect(() => contexts.get("board")?.capability("clock")).toThrow(
			'plugin "board" did not declare the capability "clock" in its manifest',
		);
		expect(provided).toEqual(["clock"]);
	});

	test("keeps deactivating when one plugin fails to deactivate and reports it", async () => {
		const journal: string[] = [];
		const { plugins, entries } = await start({
			packages: [
				packageOf(recordingPlugin(journal, { name: "notes" })),
				packageOf(
					definePlugin({
						manifest: { name: "board" },
						deactivate: () =>
							Promise.reject(new RangeError("queue not drained")),
					}),
				),
			],
			enabledPlugins: ["notes", "board"],
		});

		const outcome = await plugins.deactivate();

		expect(outcome).toBe("incomplete");
		expect(journal).toEqual(["activate notes", "deactivate notes"]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin failed to deactivate",
				plugin: "board",
				error: {
					name: "RangeError",
					message: "queue not drained",
					stack: expect.stringContaining("kernel.test.ts"),
				},
			}),
		);
	});

	test("deactivates each plugin once, however often shutdown asks", async () => {
		const journal: string[] = [];
		const { plugins } = await start({
			packages: [packageOf(recordingPlugin(journal, { name: "notes" }))],
			enabledPlugins: ["notes"],
		});

		const outcomes = await Promise.all([
			plugins.deactivate(),
			plugins.deactivate(),
		]);

		expect(outcomes).toEqual(["clean", "clean"]);
		expect(journal).toEqual(["activate notes", "deactivate notes"]);
	});

	test("tells the operator which plugin package it could not read and loads the others", async () => {
		const { plugins, entries } = await start({
			packages: [packageOf(definePlugin({ manifest: { name: "notes" } }))],
			unreadable: [
				{
					directory: "/app/packages/plugin-board",
					problem: "package.json is not valid JSON",
				},
			],
			enabledPlugins: ["notes"],
		});

		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin package ignored",
				directory: "/app/packages/plugin-board",
				problem: "package.json is not valid JSON",
			}),
		);
		expect(plugins.active).toEqual(["notes"]);
		expect(plugins.failures).toEqual([]);
	});

	test("starts without plugins and reports it when discovery fails", async () => {
		const { logger, entries } = recordingLogger();
		const failure = Object.assign(new Error("s3cr3t-detail"), {
			code: "EACCES",
		});

		const plugins = await startPlugins({
			discover: () => Promise.reject(failure),
			enabledPlugins: ["notes"],
			capabilityProviders: {},
			migrateSchemas: migratingIntoFreshDatabase(),
			hookTimeout: NEVER_EXPIRING,
			logger,
		});

		expect(plugins.active).toEqual([]);
		expect(plugins.failures.map((failure) => failure.reason)).toEqual([
			"unknown_plugin",
		]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin discovery failed",
				reason: "EACCES",
			}),
		);
		expect(JSON.stringify(entries)).not.toContain("s3cr3t-detail");
	});

	test("logs each lifecycle step from discovery to deactivation", async () => {
		const { plugins, entries } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "board", requires: { notes: "^1.0.0" } },
					}),
				),
				packageOf(definePlugin({ manifest: { name: "notes" } }), "1.4.0"),
			],
			enabledPlugins: ["board", "notes"],
		});

		await plugins.deactivate();

		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: "info",
					message: "plugins discovered",
					packages: ["@workbench/plugin-board", "@workbench/plugin-notes"],
				}),
				expect.objectContaining({
					level: "info",
					message: "plugins resolved",
					activationOrder: ["notes", "board"],
				}),
				expect.objectContaining({
					level: "info",
					message: "plugin activated",
					plugin: "notes",
					version: "1.4.0",
				}),
				expect.objectContaining({
					level: "info",
					message: "plugin activated",
					plugin: "board",
					version: "1.0.0",
				}),
				expect.objectContaining({
					level: "info",
					message: "plugins started",
					active: ["notes", "board"],
					notLoaded: [],
				}),
			]),
		);
		expect(
			entries
				.filter(({ message }) => message === "plugin deactivated")
				.map(({ level, plugin }) => ({ level, plugin })),
		).toEqual([
			{ level: "info", plugin: "board" },
			{ level: "info", plugin: "notes" },
		]);
	});

	test("gives up on a plugin entry that does not finish loading and starts the others", async () => {
		const journal: string[] = [];
		const timers = manualTimers();
		const timeUp = timers.next();

		const starting = start({
			packages: [
				{
					packageName: "@workbench/plugin-notes",
					pluginName: "notes",
					version: "1.0.0",
					loadDefinition: () => new Promise(() => {}),
				},
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
				packageOf(recordingPlugin(journal, { name: "cards" })),
			],
			enabledPlugins: ["notes", "board", "cards"],
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});
		(await timeUp)();
		const { plugins, entries } = await starting;

		const detail =
			'plugin package "@workbench/plugin-notes" did not finish loading its plugin entry within 5000 ms';
		expect(plugins.failures).toEqual([
			{ plugin: "notes", reason: "load_timed_out", detail },
			{
				plugin: "board",
				reason: "dependency_not_loaded",
				detail: `plugin "board" requires plugin "notes", which was not loaded: ${detail}`,
			},
		]);
		expect(plugins.active).toEqual(["cards"]);
		expect(journal).toEqual(["activate cards"]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin not loaded",
				plugin: "notes",
				reason: "load_timed_out",
			}),
		);
	});

	test("ignores a plugin entry that fails to load after it has timed out", async () => {
		const timers = manualTimers();
		const timeUp = timers.next();
		const loading = Promise.withResolvers<unknown>();

		const starting = start({
			packages: [
				{
					packageName: "@workbench/plugin-notes",
					pluginName: "notes",
					version: "1.0.0",
					loadDefinition: () => loading.promise,
				},
			],
			enabledPlugins: ["notes"],
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});
		(await timeUp)();
		const { plugins, entries } = await starting;
		loading.reject(new Error("too late"));
		await settled();

		expect(plugins.failures.map((failure) => failure.reason)).toEqual([
			"load_timed_out",
		]);
		expect(JSON.stringify(entries)).not.toContain("too late");
	});

	test("activates no further plugin once it is told to stop and deactivates the active ones", async () => {
		const journal: string[] = [];
		const stop = new AbortController();

		const { plugins, entries } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "notes" },
						activate: () => {
							journal.push("activate notes");
							stop.abort();
						},
						deactivate: () => {
							journal.push("deactivate notes");
						},
					}),
				),
				packageOf(recordingPlugin(journal, { name: "board" })),
				packageOf(recordingPlugin(journal, { name: "cards" })),
			],
			enabledPlugins: ["notes", "board", "cards"],
			stopSignal: stop.signal,
		});
		await plugins.deactivate();

		expect(plugins.active).toEqual(["notes"]);
		expect(plugins.failures).toEqual([]);
		expect(journal).toEqual(["activate notes", "deactivate notes"]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "info",
				message: "plugin start stopped",
				notActivated: ["board", "cards"],
			}),
		);
	});

	test("loads no plugin entry when it is told to stop before the plugins are resolved", async () => {
		const loaded: string[] = [];
		const stop = new AbortController();
		stop.abort();

		const { plugins } = await start({
			packages: [
				{
					packageName: "@workbench/plugin-notes",
					pluginName: "notes",
					version: "1.0.0",
					loadDefinition: async () => {
						loaded.push("notes");
						return definePlugin({ manifest: { name: "notes" } });
					},
				},
			],
			enabledPlugins: ["notes"],
			stopSignal: stop.signal,
		});

		expect(loaded).toEqual([]);
		expect(plugins.active).toEqual([]);
		expect(plugins.failures).toEqual([]);
	});

	test("stops the clock of a plugin entry whose loading throws at once", async () => {
		const timers = manualTimers();

		const { plugins } = await start({
			packages: [
				{
					packageName: "@workbench/plugin-notes",
					pluginName: "notes",
					version: "1.0.0",
					loadDefinition: () => {
						throw new SyntaxError("Unexpected token '}'");
					},
				},
			],
			enabledPlugins: ["notes"],
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});

		expect(plugins.failures.map((failure) => failure.reason)).toEqual([
			"invalid_manifest",
		]);
		expect(timers.delaysMs).toContain(5000);
		expect(timers.pending()).toBe(0);
	});

	test("does not blame a plugin for a capability the instance fails to provide", async () => {
		const journal: string[] = [];
		const timers = manualTimers();

		const { plugins, entries } = await start({
			packages: [
				packageOf(
					recordingPlugin(journal, { name: "notes", capabilities: ["clock"] }),
				),
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
				packageOf(recordingPlugin(journal, { name: "cards" })),
			],
			enabledPlugins: ["notes", "board", "cards"],
			capabilityProviders: {
				clock: () => {
					throw new RangeError("clock offline");
				},
			},
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});

		const detail =
			'plugin "notes" was not activated because the instance could not provide the capability "clock" (RangeError: clock offline)';
		expect(plugins.failures).toEqual([
			{
				plugin: "notes",
				reason: "capability_unavailable",
				detail,
				error: {
					name: "RangeError",
					message: "clock offline",
					stack: expect.stringContaining("kernel.test.ts"),
				},
			},
			{
				plugin: "board",
				reason: "dependency_not_loaded",
				detail: `plugin "board" requires plugin "notes", which was not loaded: ${detail}`,
			},
		]);
		expect(plugins.active).toEqual(["cards"]);
		expect(journal).toEqual(["activate cards"]);
		expect(timers.pending()).toBe(0);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin not loaded",
				plugin: "notes",
				reason: "capability_unavailable",
			}),
		);
	});

	test("tells the operator what discovery threw when it fails for no system reason", async () => {
		const { logger, entries } = recordingLogger();

		await startPlugins({
			discover: () => Promise.reject(new TypeError("packages is not iterable")),
			enabledPlugins: [],
			capabilityProviders: {},
			migrateSchemas: migratingIntoFreshDatabase(),
			hookTimeout: NEVER_EXPIRING,
			logger,
		});

		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin discovery failed",
				reason: "unknown",
				error: {
					name: "TypeError",
					message: "packages is not iterable",
					stack: expect.stringContaining("kernel.test.ts"),
				},
			}),
		);
	});
});

describe("plugin schemas", () => {
	function capturingContexts() {
		const contexts = new Map<string, PluginContext>();
		const plugin = (manifest: PluginDefinition["manifest"]): PluginDefinition =>
			definePlugin({
				manifest,
				activate: (ctx) => {
					contexts.set(manifest.name, ctx);
				},
			});
		return { contexts, plugin };
	}

	test("migrates the schema of each plugin with the database capability before activating any plugin", async () => {
		const database = await freshDatabase();
		const seenAtActivation: unknown[] = [];
		const observing = (manifest: PluginDefinition["manifest"]) =>
			definePlugin({
				manifest,
				activate: async () => {
					seenAtActivation.push({
						plugin: manifest.name,
						schemas: await pluginSchemasIn(database),
						applied: await appliedMigrationsIn(database),
					});
				},
			});

		await start({
			packages: [
				withMigrations(
					packageOf(
						observing({ name: "sticky-notes", capabilities: ["database"] }),
					),
					[CREATE_NOTES],
				),
				packageOf(observing({ name: "board", capabilities: ["database"] })),
				packageOf(observing({ name: "cards" })),
			],
			enabledPlugins: ["cards", "sticky-notes", "board"],
			migrateSchemas: migratingInto(database),
		});

		const migrated = {
			schemas: ["plugin_board", "plugin_sticky_notes"],
			applied: [
				{ schema: "plugin_sticky_notes", migration: "0001_create_notes.sql" },
			],
		};
		expect(seenAtActivation).toEqual([
			{ plugin: "cards", ...migrated },
			{ plugin: "sticky-notes", ...migrated },
			{ plugin: "board", ...migrated },
		]);
	});

	test("tells a plugin with the database capability the name of its schema", async () => {
		const { contexts, plugin } = capturingContexts();

		await start({
			packages: [
				packageOf(plugin({ name: "sticky-notes", capabilities: ["database"] })),
				packageOf(plugin({ name: "cards" })),
			],
			enabledPlugins: ["sticky-notes", "cards"],
		});

		expect(contexts.get("sticky-notes")?.capability("database")).toEqual({
			schema: schemaName("plugin_sticky_notes"),
		});
		expect(() => contexts.get("cards")?.capability("database")).toThrow(
			new UndeclaredCapabilityError("cards", "database"),
		);
	});

	test("does not load a plugin whose schema migration fails, nor the plugins requiring it", async () => {
		const journal: string[] = [];

		const { plugins, entries } = await start({
			packages: [
				withMigrations(
					packageOf(
						recordingPlugin(journal, {
							name: "notes",
							capabilities: ["database"],
						}),
					),
					[BROKEN_CREATE_NOTES],
				),
				packageOf(
					recordingPlugin(journal, {
						name: "board",
						requires: { notes: "^1.0.0" },
					}),
				),
				packageOf(
					recordingPlugin(journal, {
						name: "cards",
						capabilities: ["database"],
					}),
				),
			],
			enabledPlugins: ["notes", "board", "cards"],
		});

		const failure: LoadFailure = {
			plugin: "notes",
			reason: "migration_failed",
			detail: expect.stringContaining(
				'plugin "notes" was not activated because its schema could not be migrated: migration "0001_create_notes.sql" of schema "plugin_notes" failed (PostgresError: syntax error',
			),
			error: expect.objectContaining({ name: "PostgresError" }),
		};
		expect(plugins.failures).toEqual([
			failure,
			{
				plugin: "board",
				reason: "dependency_not_loaded",
				detail: expect.stringContaining(
					'plugin "board" requires plugin "notes", which was not loaded: plugin "notes" was not activated because its schema could not be migrated',
				),
			},
		]);
		expect(plugins.active).toEqual(["cards"]);
		expect(journal).toEqual(["activate cards"]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "plugin not loaded",
				...failure,
			}),
		);
	});

	test("does not load the plugins with the database capability when the migration cannot run at all", async () => {
		const journal: string[] = [];

		const { plugins } = await start({
			packages: [
				packageOf(
					recordingPlugin(journal, {
						name: "notes",
						capabilities: ["database"],
					}),
				),
				packageOf(recordingPlugin(journal, { name: "cards" })),
			],
			enabledPlugins: ["notes", "cards"],
			migrateSchemas: migratingInto(PostgresGate.create()),
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "notes",
				reason: "migration_failed",
				detail:
					'plugin "notes" was not activated because its schema could not be migrated: PostgresError: Failed to connect',
				error: expect.objectContaining({
					name: "PostgresError",
					message: "Failed to connect",
				}),
			},
		]);
		expect(journal).toEqual(["activate cards"]);
	});

	test("attributes a failed migration to the plugin owning its schema, not to the plugin migrated before it", async () => {
		const journal: string[] = [];

		const { plugins } = await start({
			packages: [
				withMigrations(
					packageOf(
						recordingPlugin(journal, {
							name: "cards",
							capabilities: ["database"],
						}),
					),
					[CREATE_NOTES],
				),
				withMigrations(
					packageOf(
						recordingPlugin(journal, {
							name: "notes",
							capabilities: ["database"],
						}),
					),
					[BROKEN_CREATE_NOTES],
				),
			],
			enabledPlugins: ["cards", "notes"],
		});

		expect(plugins.failures).toEqual([
			expect.objectContaining({ plugin: "notes", reason: "migration_failed" }),
		]);
		expect(plugins.active).toEqual(["cards"]);
		expect(journal).toEqual(["activate cards"]);
	});

	test("neither activates the plugins nor reports them as not loaded when the migration run is stopped", async () => {
		const database = await freshDatabase();
		const stop = new AbortController();
		const journal: string[] = [];

		const { plugins, entries } = await start({
			packages: [
				{
					...packageOf(
						recordingPlugin(journal, {
							name: "notes",
							capabilities: ["database"],
						}),
					),
					loadMigrations: async () => {
						stop.abort();
						return [CREATE_NOTES];
					},
				},
				packageOf(recordingPlugin(journal, { name: "cards" })),
			],
			enabledPlugins: ["notes", "cards"],
			migrateSchemas: migratingInto(database, stop.signal),
			stopSignal: stop.signal,
		});

		expect(plugins.failures).toEqual([]);
		expect(plugins.active).toEqual([]);
		expect(journal).toEqual([]);
		expect(await pluginSchemasIn(database)).toEqual([]);
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "info",
				message: "plugin start stopped",
				notActivated: ["notes", "cards"],
			}),
		);
	});

	test("does not load a plugin whose migrations cannot be read and migrates the others", async () => {
		const database = await freshDatabase();

		const { plugins } = await start({
			packages: [
				{
					...packageOf(
						definePlugin({
							manifest: { name: "notes", capabilities: ["database"] },
						}),
					),
					loadMigrations: () =>
						Promise.reject(
							new Error('"create_notes.sql" does not start with a number'),
						),
				},
				withMigrations(
					packageOf(
						definePlugin({
							manifest: { name: "cards", capabilities: ["database"] },
						}),
					),
					[CREATE_NOTES],
				),
			],
			enabledPlugins: ["notes", "cards"],
			migrateSchemas: migratingInto(database),
		});

		expect(plugins.failures).toEqual([
			expect.objectContaining({
				plugin: "notes",
				reason: "migration_failed",
				detail:
					'plugin "notes" was not activated because its schema could not be migrated: Error: "create_notes.sql" does not start with a number',
			}),
		]);
		expect(plugins.active).toEqual(["cards"]);
		expect(await pluginSchemasIn(database)).toEqual(["plugin_cards"]);
		expect(await appliedMigrationsIn(database)).toEqual([
			{ schema: "plugin_cards", migration: "0001_create_notes.sql" },
		]);
	});

	test("migrates no schema once it is told to stop while loading the plugins", async () => {
		const database = await freshDatabase();
		const stop = new AbortController();

		const { plugins } = await start({
			packages: [
				{
					...packageOf(
						definePlugin({
							manifest: { name: "notes", capabilities: ["database"] },
						}),
					),
					loadDefinition: async () => {
						stop.abort();
						return definePlugin({
							manifest: { name: "notes", capabilities: ["database"] },
						});
					},
				},
			],
			enabledPlugins: ["notes"],
			migrateSchemas: migratingInto(database),
			stopSignal: stop.signal,
		});

		expect(plugins.active).toEqual([]);
		expect(await pluginSchemasIn(database)).toEqual([]);
	});

	test("does not load a plugin that ships migrations without declaring the database capability", async () => {
		const { plugins } = await start({
			packages: [
				withMigrations(
					packageOf(definePlugin({ manifest: { name: "notes" } })),
					[CREATE_NOTES],
				),
			],
			enabledPlugins: ["notes"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "notes",
				reason: "invalid_manifest",
				detail:
					'plugin package "@workbench/plugin-notes" has an invalid manifest: package.json declares migrations, but manifest.capabilities does not name "database"',
			},
		]);
	});

	test("does not load a plugin whose name is too long for the name of its schema, and migrates nothing for it", async () => {
		const database = await freshDatabase();
		const name = `notes-${"a".repeat(51)}`;

		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({ manifest: { name, capabilities: ["database"] } }),
				),
			],
			enabledPlugins: [name],
			migrateSchemas: migratingInto(database),
		});

		expect(plugins.failures).toEqual([
			{
				plugin: name,
				reason: "invalid_manifest",
				detail: `plugin package "@workbench/plugin-${name}" has an invalid manifest: manifest.name must have at most 56 characters`,
			},
		]);
		expect(await pluginSchemasIn(database)).toEqual([]);
	});
});

describe("plugin schemas in Postgres", () => {
	test("creates a schema with its tables only for the plugin with the database capability", async () => {
		const database = await freshDatabase();

		await start({
			packages: [
				withMigrations(
					packageOf(
						definePlugin({
							manifest: { name: "sticky-notes", capabilities: ["database"] },
						}),
					),
					[CREATE_NOTES],
				),
				packageOf(definePlugin({ manifest: { name: "cards" } })),
			],
			enabledPlugins: ["sticky-notes", "cards"],
			migrateSchemas: migratingInto(database),
		});

		const tables = await database.sql<{ table_name: string }[]>`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'plugin_sticky_notes'`;
		expect(await pluginSchemasIn(database)).toEqual(["plugin_sticky_notes"]);
		expect(tables.map((row) => row.table_name)).toEqual(["notes"]);
	});
});

const createCard = defineOperation({
	name: "createCard",
	kind: "mutation",
	target: "workspace",
	right: "board.card.create",
	input: z.object({ title: z.string() }),
	output: z.object({ id: z.string() }),
	execute: async () => ({ id: "card-1" }),
});

const listCards = defineOperation({
	name: "listCards",
	kind: "query",
	target: "workspace",
	right: "board.card.read",
	input: z.object({}),
	output: z.object({ ids: z.array(z.string()) }),
	execute: async () => ({ ids: [] }),
});

describe("operations of plugins", () => {
	test("are registered under the plugin name and the name of the operation", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "board" },
						operations: [createCard, listCards],
					}),
				),
			],
			enabledPlugins: ["board"],
		});

		expect([
			plugins.operations.find("board.createCard")?.name,
			plugins.operations.find("board.listCards")?.name,
			plugins.operations.find("createCard"),
		]).toEqual(["board.createCard", "board.listCards", undefined]);
	});

	test("are not registered for a plugin that is not loaded", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "board", requires: { missing: "^1.0.0" } },
						operations: [createCard],
					}),
				),
			],
			enabledPlugins: ["board"],
		});

		expect(plugins.operations.find("board.createCard")).toBeUndefined();
	});

	test.each([
		[
			"an operation name declared twice",
			[createCard, listCards, { ...listCards, right: "board.card.list" }],
			'operation "board.listCards" is declared more than once',
		],
		[
			"an operation without a right",
			[{ ...createCard, right: undefined }],
			'operation "board.createCard" must name exactly one right of plugin "board", such as "board.workspace.edit"',
		],
		[
			"an operation with several rights",
			[{ ...createCard, right: ["board.card.create", "board.card.edit"] }],
			'operation "board.createCard" must name exactly one right of plugin "board", such as "board.workspace.edit"',
		],
		[
			"an operation with a right of another plugin",
			[{ ...createCard, right: "chat.message.send" }],
			'operation "board.createCard" must name exactly one right of plugin "board", such as "board.workspace.edit"',
		],
		[
			"an operation name that is not a verb and an object in camelCase",
			[{ ...createCard, name: "create-card" }],
			'operations[0].name must be a verb and an object in camelCase, such as "renameWorkspace"',
		],
		[
			"an operation of unknown kind",
			[{ ...createCard, kind: "command" }],
			'operation "board.createCard" must be of kind "query" or "mutation"',
		],
		[
			"an operation with an unknown target",
			[{ ...createCard, target: "instance" }],
			'operation "board.createCard" must target "object" or "workspace"',
		],
		[
			"an operation without an input schema",
			[{ ...createCard, input: { title: "string" } }],
			'operation "board.createCard" must declare its input as a schema',
		],
		[
			"an operation without an output schema",
			[{ ...createCard, output: undefined }],
			'operation "board.createCard" must declare its output as a schema',
		],
		[
			"an operation that cannot be executed",
			[{ ...createCard, execute: "INSERT" }],
			'operation "board.createCard" must have an execute function',
		],
		[
			"operations that are not a list",
			{ createCard },
			"operations must be a list of operations",
		],
		[
			"an operation that is not an object",
			["createCard"],
			"operations[0] must be an operation",
		],
	])("rejects a plugin with %s", async (_case, operations, problem) => {
		const { plugins } = await start({
			packages: [
				{
					packageName: "@workbench/plugin-board",
					pluginName: "board",
					version: "1.0.0",
					loadDefinition: async () => ({
						manifest: { name: "board" },
						operations,
					}),
				},
			],
			enabledPlugins: ["board"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "board",
				reason: "invalid_manifest",
				detail: `plugin package "@workbench/plugin-board" has an invalid manifest: ${problem}`,
			},
		]);
		expect(plugins.operations.find("board.createCard")).toBeUndefined();
	});
});

const cardCreated = defineEvent({
	plugin: "board",
	name: "CardCreated",
	version: 1,
	payload: z.object({ cardId: z.string() }),
});

const countCard = defineEventSubscription({
	event: cardCreated,
	handle: async () => {},
});

const CARD_CREATED_CAPABILITY = "event:board.CardCreated";

const statisticsCountingCards = packageOf(
	definePlugin({
		manifest: {
			name: "statistics",
			capabilities: [eventSubscriptionCapability(cardCreated)],
		},
		subscriptions: [countCard],
	}),
);

describe("events of plugins", () => {
	test("are registered under the name of the publishing plugin, with the subscriptions of the plugins that declare the capability", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({ manifest: { name: "board" }, events: [cardCreated] }),
				),
				packageOf(
					definePlugin({
						manifest: {
							name: "statistics",
							capabilities: [eventSubscriptionCapability(cardCreated)],
						},
						subscriptions: [countCard],
					}),
				),
			],
			enabledPlugins: ["board", "statistics"],
		});

		expect(plugins.failures).toEqual([]);
		expect(plugins.events.findEvent("board.CardCreated")).toEqual(
			expect.objectContaining({ name: "board.CardCreated", version: 1 }),
		);
		expect(plugins.events.findEvent("CardCreated")).toBeUndefined();
		expect(
			plugins.events
				.subscriptions()
				.map(({ subscriber, event }) => ({ subscriber, event })),
		).toEqual([{ subscriber: "statistics", event: "board.CardCreated" }]);
	});

	test("warns the operator of a subscription to an event that no active plugin declares, and loads the subscribing plugin all the same", async () => {
		const { plugins, entries } = await start({
			packages: [
				packageOf(
					definePlugin({ manifest: { name: "board" }, events: [cardCreated] }),
				),
				statisticsCountingCards,
			],
			enabledPlugins: ["statistics"],
		});

		expect(plugins.active).toEqual(["statistics"]);
		expect(plugins.failures).toEqual([]);
		expect(entries.filter((entry) => entry.level === "warn")).toEqual([
			expect.objectContaining({
				message: "subscribed event not declared",
				subscriber: "statistics",
				event: "board.CardCreated",
			}),
		]);
	});

	test("does not warn of a subscription to an event that an active plugin declares", async () => {
		const { entries } = await start({
			packages: [
				packageOf(
					definePlugin({ manifest: { name: "board" }, events: [cardCreated] }),
				),
				statisticsCountingCards,
			],
			enabledPlugins: ["board", "statistics"],
		});

		expect(entries.filter((entry) => entry.level === "warn")).toEqual([]);
	});

	test("does not load a plugin that subscribes to an event without declaring the capability for it", async () => {
		const { plugins, entries } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "statistics" },
						subscriptions: [countCard],
					}),
				),
			],
			enabledPlugins: ["statistics"],
		});

		const failure: LoadFailure = {
			plugin: "statistics",
			reason: "invalid_manifest",
			detail:
				'plugin package "@workbench/plugin-statistics" has an invalid manifest: the subscription to event "board.CardCreated" requires the capability "event:board.CardCreated" in manifest.capabilities',
		};
		expect(plugins.active).toEqual([]);
		expect(plugins.failures).toEqual([failure]);
		expect(plugins.events.subscriptions()).toEqual([]);
		expect(entries).toContainEqual(
			expect.objectContaining({ message: "plugin not loaded", ...failure }),
		);
	});

	test("does not let the capability for one event cover the subscription to another", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: {
							name: "statistics",
							capabilities: ["event:board.CardArchived"],
						},
						subscriptions: [countCard],
					}),
				),
			],
			enabledPlugins: ["statistics"],
		});

		expect(plugins.failures).toEqual([
			expect.objectContaining({
				plugin: "statistics",
				reason: "invalid_manifest",
				detail: expect.stringContaining(
					'requires the capability "event:board.CardCreated"',
				),
			}),
		]);
	});

	test("hands a subscribing plugin the event its capability names", async () => {
		const contexts: PluginContext[] = [];

		await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: {
							name: "statistics",
							capabilities: [CARD_CREATED_CAPABILITY],
						},
						subscriptions: [countCard],
						activate: (ctx) => {
							contexts.push(ctx);
						},
					}),
				),
			],
			enabledPlugins: ["statistics"],
		});

		expect(contexts[0]?.capability(CARD_CREATED_CAPABILITY)).toEqual({
			event: "board.CardCreated",
		});
	});

	test("registers neither events nor subscriptions of a plugin that is not loaded", async () => {
		const { plugins } = await start({
			packages: [
				packageOf(
					definePlugin({
						manifest: {
							name: "board",
							requires: { missing: "^1.0.0" },
							capabilities: [CARD_CREATED_CAPABILITY],
						},
						events: [cardCreated],
						subscriptions: [countCard],
					}),
				),
			],
			enabledPlugins: ["board"],
		});

		expect(plugins.events.findEvent("board.CardCreated")).toBeUndefined();
		expect(plugins.events.subscriptions()).toEqual([]);
	});

	test.each([
		[
			"an event under the name of another plugin",
			{ events: [{ ...cardCreated, plugin: "chat" }] },
			'events[0] must name "board" as its plugin, the plugin that publishes it',
		],
		[
			"an event name that is not in PascalCase",
			{ events: [{ ...cardCreated, name: "card-created" }] },
			'events[0].name must be in PascalCase, such as "WorkspaceRenamed"',
		],
		[
			"an event without a version",
			{ events: [{ ...cardCreated, version: undefined }] },
			'event "board.CardCreated" must have a version that is a positive integer',
		],
		[
			"an event with a version below 1",
			{ events: [{ ...cardCreated, version: 0 }] },
			'event "board.CardCreated" must have a version that is a positive integer',
		],
		[
			"an event without a payload schema",
			{ events: [{ ...cardCreated, payload: { cardId: "string" } }] },
			'event "board.CardCreated" must declare its payload as a schema',
		],
		[
			"an event declared twice",
			{ events: [cardCreated, { ...cardCreated, version: 2 }] },
			'event "board.CardCreated" is declared more than once',
		],
		[
			"events that are not a list",
			{ events: { cardCreated } },
			"events must be a list of event definitions",
		],
		[
			"an event that is not an object",
			{ events: ["CardCreated"] },
			"events[0] must be an event definition",
		],
		[
			"a subscription to something that is not an event definition",
			{ subscriptions: [{ event: "board.CardCreated", handle: () => {} }] },
			"subscriptions[0].event must be an event definition from the contract of the publishing plugin",
		],
		[
			"a subscription to an event whose plugin is not a plugin name",
			{
				subscriptions: [
					{ ...countCard, event: { ...cardCreated, plugin: "The Board" } },
				],
			},
			"subscriptions[0].event.plugin must be the name of the publishing plugin",
		],
		[
			"a subscription to an event whose name is not in PascalCase",
			{
				subscriptions: [
					{ ...countCard, event: { ...cardCreated, name: "card-created" } },
				],
			},
			'subscriptions[0].event.name must be in PascalCase, such as "WorkspaceRenamed"',
		],
		[
			"a subscription without a handler",
			{ subscriptions: [{ event: cardCreated }] },
			'the subscription to event "board.CardCreated" must have a handle function',
		],
		[
			"two subscriptions to the same event",
			{ subscriptions: [countCard, countCard] },
			'event "board.CardCreated" is subscribed to more than once',
		],
		[
			"subscriptions that are not a list",
			{ subscriptions: { countCard } },
			"subscriptions must be a list of event subscriptions",
		],
		[
			"a subscription that is not an object",
			{ subscriptions: ["board.CardCreated"] },
			"subscriptions[0] must be an event subscription",
		],
		[
			"an event capability that names no event",
			{ manifest: { name: "board", capabilities: ["event:board"] } },
			'manifest.capabilities names "event:board", which this instance does not offer',
		],
	])("rejects a plugin with %s", async (_case, declared, problem) => {
		const { plugins } = await start({
			packages: [
				{
					packageName: "@workbench/plugin-board",
					pluginName: "board",
					version: "1.0.0",
					loadDefinition: async () => ({
						manifest: {
							name: "board",
							capabilities: [CARD_CREATED_CAPABILITY],
						},
						...declared,
					}),
				},
			],
			enabledPlugins: ["board"],
		});

		expect(plugins.failures).toEqual([
			{
				plugin: "board",
				reason: "invalid_manifest",
				detail: `plugin package "@workbench/plugin-board" has an invalid manifest: ${problem}`,
			},
		]);
	});
});
