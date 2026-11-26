import { describe, expect, test } from "bun:test";
import {
	definePlugin,
	type PluginContext,
	type PluginDefinition,
} from "@workbench/sdk";
import {
	type CapabilityProviders,
	type HookTimeout,
	type LoadFailure,
	type PluginPackage,
	startPlugins,
	UndeclaredCapabilityError,
	type UnreadablePackage,
} from "./kernel.ts";
import { createLogger } from "./logger.ts";

type LogEntry = Record<string, unknown>;

function recordingLogger() {
	const entries: LogEntry[] = [];
	const logger = createLogger({
		level: "debug",
		now: () => new Date("2026-11-26T08:00:00.000Z"),
		write: (line) => entries.push(JSON.parse(line)),
	});
	return { logger, entries };
}

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

type Scenario = {
	readonly packages: readonly PluginPackage[];
	readonly unreadable?: readonly UnreadablePackage[];
	readonly enabledPlugins: readonly string[];
	readonly capabilityProviders?: CapabilityProviders;
	readonly hookTimeout?: HookTimeout;
};

const NEVER_EXPIRING: HookTimeout = { ms: 10_000, setTimer: () => () => {} };

/** Timers that expire only when the test says so. */
function manualTimers() {
	const delaysMs: number[] = [];
	let cancelled = 0;
	let announce: ((expire: () => void) => void) | undefined;
	const setTimer: HookTimeout["setTimer"] = (expire, delayMs) => {
		delaysMs.push(delayMs);
		announce?.(expire);
		announce = undefined;
		return () => {
			cancelled += 1;
		};
	};
	return {
		setTimer,
		delaysMs,
		cancelled: () => cancelled,
		/** Resolves with the expiry of the next timer that is set. */
		next: () =>
			new Promise<() => void>((resolve) => {
				announce = resolve;
			}),
	};
}

function hanging(): Promise<void> {
	return new Promise(() => {});
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
		hookTimeout: scenario.hookTimeout ?? NEVER_EXPIRING,
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

		expect(plugins.failures).toEqual([
			{
				plugin: "notes",
				reason: "dependency_cycle",
				detail:
					'plugin "notes" is part of a dependency cycle: board -> notes -> board',
			},
			{
				plugin: "board",
				reason: "dependency_cycle",
				detail:
					'plugin "board" is part of a dependency cycle: board -> notes -> board',
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
			plugins.failures.map(({ plugin, reason }) => ({ plugin, reason })),
		).toEqual([
			{ plugin: "tags", reason: "dependency_cycle" },
			{ plugin: "notes", reason: "dependency_cycle" },
			{ plugin: "board", reason: "dependency_cycle" },
			{ plugin: "cards", reason: "dependency_not_loaded" },
		]);
		expect(plugins.failures[2]?.detail).toBe(
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

			expect(plugins.failures).toEqual(
				cycles.map(({ plugin, cycle }) => ({
					plugin,
					reason: "dependency_cycle",
					detail: `plugin "${plugin}" is part of a dependency cycle: ${cycle}`,
				})),
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
		const timeUp = timers.next();

		const starting = start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "notes" },
						activate: hanging,
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
		(await timeUp)();
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
		const timeUp = timers.next();
		const activation = Promise.withResolvers<void>();

		const starting = start({
			packages: [
				packageOf(
					definePlugin({
						manifest: { name: "notes" },
						activate: () => activation.promise,
					}),
				),
			],
			enabledPlugins: ["notes"],
			hookTimeout: { ms: 5000, setTimer: timers.setTimer },
		});
		(await timeUp)();
		const { plugins } = await starting;
		activation.reject(new Error("too late"));

		expect(plugins.failures.map((failure) => failure.reason)).toEqual([
			"activation_timed_out",
		]);
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

	test("stops the clock of every activation and deactivation that finishes in time", async () => {
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

		expect(timers.delaysMs).toEqual([5000, 5000, 5000, 5000]);
		expect(timers.cancelled()).toBe(4);
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
			hookTimeout: NEVER_EXPIRING,
			logger,
		});

		expect(plugins.active).toEqual([]);
		expect(plugins.failures.map((failure) => failure.reason)).toEqual([
			"unknown_plugin",
		]);
		expect(entries[0]).toMatchObject({
			level: "error",
			message: "plugin discovery failed",
			reason: "EACCES",
		});
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

		expect(entries).toEqual([
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
			expect.objectContaining({
				level: "info",
				message: "plugin deactivated",
				plugin: "board",
			}),
			expect.objectContaining({
				level: "info",
				message: "plugin deactivated",
				plugin: "notes",
			}),
		]);
	});
});
