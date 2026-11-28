import { afterEach, describe, expect, test } from "bun:test";
import {
	type Actor,
	DATABASE_CAPABILITY,
	defineEvent,
	defineEventSubscription,
	defineOperation,
	definePlugin,
	type EventSubscription,
	eventSubscriptionCapability,
	type OperationContext,
	type PublishedEvent,
} from "@workbench/sdk";
import { z } from "zod";
import { Secret } from "./config.ts";
import { createEventDelivery } from "./event-outbox.ts";
import { setSystemTimer } from "./hook-timeout.ts";
import { type PluginPackage, startPlugins } from "./kernel.ts";
import { createOperationPipeline } from "./operation-pipeline.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "./schema-migrations.ts";
import {
	type OperationHarness,
	type OperationHarnessOptions,
	startOperationHarness,
} from "./testing/operation-harness.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { recordingLogger } from "./testing/recording-logger.ts";
import { createWorkspace } from "./workspaces.ts";

const ALICE: Actor = { kind: "user", id: "alice" };

const entryAdded = defineEvent({
	plugin: "ledger",
	name: "EntryAdded",
	version: 1,
	payload: z.object({ entryId: z.string() }),
});

const invoiceSent = defineEvent({
	plugin: "billing",
	name: "InvoiceSent",
	version: 1,
	payload: z.object({ entryId: z.string() }),
});

const billing: PluginPackage = {
	packageName: "@workbench/plugin-billing",
	pluginName: "billing",
	version: "1.0.0",
	loadDefinition: async () =>
		definePlugin({ manifest: { name: "billing" }, events: [invoiceSent] }),
};

const addEntry = defineOperation({
	name: "addEntry",
	kind: "mutation",
	target: "workspace",
	right: "ledger.entry.add",
	input: z.object({ amount: z.number().int() }),
	output: z.object({ id: z.string() }),
	execute: async ({ amount }, ctx) => {
		const id = ctx.newId();
		await ctx.sql`INSERT INTO entries (id, amount) VALUES (${id}, ${amount})`;
		const payload = { entryId: id, amount };
		await ctx.publish(entryAdded, payload);
		if (amount < 0) throw new Error("an entry needs a positive amount");
		return { id };
	},
});

const entryAddedOfAnyPayload = defineEvent({
	...entryAdded,
	payload: z.unknown(),
});

const entryRemoved = defineEvent({
	plugin: "ledger",
	name: "EntryRemoved",
	version: 1,
	payload: z.object({ entryId: z.string() }),
});

function addingEntryAndPublishing(
	name: string,
	publish: (ctx: OperationContext, entryId: string) => Promise<void>,
) {
	return defineOperation({
		...addEntry,
		name,
		execute: async ({ amount }, ctx) => {
			const id = ctx.newId();
			await ctx.sql`INSERT INTO entries (id, amount) VALUES (${id}, ${amount})`;
			await publish(ctx, id);
			return { id };
		},
	});
}

const addEntryWithUndeclaredEvent = addingEntryAndPublishing(
	"addEntryWithUndeclaredEvent",
	(ctx, entryId) => ctx.publish(entryRemoved, { entryId }),
);

const addEntryWithForeignEvent = addingEntryAndPublishing(
	"addEntryWithForeignEvent",
	(ctx, entryId) => ctx.publish(invoiceSent, { entryId }),
);

const addEntryWithMalformedEvent = addingEntryAndPublishing(
	"addEntryWithMalformedEvent",
	(ctx) => ctx.publish(entryAddedOfAnyPayload, { entryId: 7 }),
);

const countEntries = defineOperation({
	name: "countEntries",
	kind: "query",
	target: "workspace",
	right: "ledger.entry.read",
	input: z.object({}),
	output: z.object({ entries: z.number() }),
	execute: async (_input, ctx) => {
		const [row] = await ctx.sql`SELECT count(*)::int AS entries FROM entries`;
		return z.object({ entries: z.number() }).parse(row);
	},
});

const announceCount = defineOperation({
	...countEntries,
	name: "announceCount",
	execute: async (_input, ctx) => {
		await ctx.publish(entryAdded, { entryId: ctx.newId() });
		return { entries: 0 };
	},
});

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () =>
		definePlugin({
			manifest: { name: "ledger", capabilities: [DATABASE_CAPABILITY] },
			operations: [
				addEntry,
				addEntryWithUndeclaredEvent,
				addEntryWithForeignEvent,
				addEntryWithMalformedEvent,
				countEntries,
				announceCount,
			],
			events: [entryAdded],
		}),
	loadMigrations: async () => [
		{
			name: "0001_create_entries.sql",
			sql: "CREATE TABLE entries (id uuid PRIMARY KEY, amount integer NOT NULL);",
		},
	],
};

type EntryAdded = PublishedEvent<{ entryId: string }>;

function subscriber(
	name: string,
	handle: EventSubscription<{ entryId: string }>["handle"],
): PluginPackage {
	return {
		packageName: `@workbench/plugin-${name}`,
		pluginName: name,
		version: "1.0.0",
		loadDefinition: async () =>
			definePlugin({
				manifest: {
					name,
					capabilities: [eventSubscriptionCapability(entryAdded)],
				},
				subscriptions: [defineEventSubscription({ event: entryAdded, handle })],
			}),
	};
}

const TALLY_MIGRATIONS = [
	{
		name: "0001_create_tallied_entries.sql",
		sql: "CREATE TABLE tallied_entries (event_id uuid PRIMARY KEY, entry_id uuid NOT NULL);",
	},
];

const listTallied = defineOperation({
	name: "listTallied",
	kind: "query",
	target: "workspace",
	right: "tally.entry.read",
	input: z.object({}),
	output: z.object({ entryIds: z.array(z.string()) }),
	execute: async (_input, ctx) => {
		const rows =
			await ctx.sql`SELECT entry_id FROM tallied_entries ORDER BY entry_id`;
		return {
			entryIds: z
				.array(z.object({ entry_id: z.string() }))
				.parse(rows)
				.map((row) => row.entry_id),
		};
	},
});

function tally(
	handle: EventSubscription<{ entryId: string }>["handle"],
): PluginPackage {
	return {
		packageName: "@workbench/plugin-tally",
		pluginName: "tally",
		version: "1.0.0",
		loadDefinition: async () =>
			definePlugin({
				manifest: {
					name: "tally",
					capabilities: [
						DATABASE_CAPABILITY,
						eventSubscriptionCapability(entryAdded),
					],
				},
				operations: [listTallied],
				subscriptions: [defineEventSubscription({ event: entryAdded, handle })],
			}),
		loadMigrations: async () => TALLY_MIGRATIONS,
	};
}

function adjustableClock(start: string) {
	let current = new Date(start);
	return {
		now: () => current,
		advanceBy: (ms: number) => {
			current = new Date(current.getTime() + ms);
		},
	};
}

const ONE_HOUR_MS = 3_600_000;

function recording(name: string) {
	const received: EntryAdded[] = [];
	const plugin = subscriber(name, async (event) => {
		received.push(event);
	});
	return { plugin, received };
}

const harnesses: OperationHarness[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.stop();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const NOT_STOPPED = new AbortController().signal;

const WORKSPACE = "00000000-0000-4000-8000-00000000aaaa";

async function startLedgerPipeline(eventsCommitted: () => void) {
	const { logger } = recordingLogger();
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	const runner: MigrationRunner = {
		databaseUrl: new Secret(database.url),
		connectionTimeoutMs: 10_000,
		statementTimeoutMs: 60_000,
		lockRetryDelayMs: () => 0,
		setTimer: setSystemTimer,
		logger,
	};
	await migrateCoreSchema(runner, CORE_MIGRATIONS_DIRECTORY, NOT_STOPPED);
	const plugins = await startPlugins({
		discover: async () => ({ packages: [ledger], unreadable: [] }),
		enabledPlugins: ["ledger"],
		capabilityProviders: {},
		migrateSchemas: (schemas) => migrateSchemas(runner, schemas, NOT_STOPPED),
		hookTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
	cleanups.push(async () => {
		await plugins.deactivate();
	});
	const now = new Date("2026-11-27T09:00:00.000Z");
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Alpha",
		createdAt: now,
	});
	return createOperationPipeline({
		sql: database.sql,
		registry: plugins.operations,
		events: plugins.events,
		now: () => now,
		newId: () => crypto.randomUUID(),
		newAuditEntryId: () => crypto.randomUUID(),
		newEventId: () => crypto.randomUUID(),
		eventsCommitted,
		jobs: plugins.jobs,
		newJobId: () => crypto.randomUUID(),
		jobsCommitted: () => {},
		random: () => 0.5,
		logger,
	});
}

async function migratedDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	await migrateCoreSchema(
		migrationRunner(database),
		CORE_MIGRATIONS_DIRECTORY,
		NOT_STOPPED,
	);
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Alpha",
		createdAt: new Date("2026-11-27T09:00:00.000Z"),
	});
	return database;
}

function migrationRunner(database: FreshDatabase): MigrationRunner {
	return {
		databaseUrl: new Secret(database.url),
		connectionTimeoutMs: 10_000,
		statementTimeoutMs: 60_000,
		lockRetryDelayMs: () => 0,
		setTimer: setSystemTimer,
		logger: recordingLogger().logger,
	};
}

async function startInstanceOn(
	database: FreshDatabase,
	packages: readonly PluginPackage[],
) {
	const { logger } = recordingLogger();
	const plugins = await startPlugins({
		discover: async () => ({ packages, unreadable: [] }),
		enabledPlugins: packages.map((plugin) => plugin.pluginName),
		capabilityProviders: {},
		migrateSchemas: (schemas) =>
			migrateSchemas(migrationRunner(database), schemas, NOT_STOPPED),
		hookTimeout: { ms: 10_000, setTimer: setSystemTimer },
		logger,
	});
	const sources = {
		sql: database.sql,
		events: plugins.events,
		now: () => new Date("2026-11-27T09:00:00.000Z"),
		newId: () => crypto.randomUUID(),
		random: () => 0.5,
		logger,
	};
	const pipeline = createOperationPipeline({
		...sources,
		registry: plugins.operations,
		newAuditEntryId: () => crypto.randomUUID(),
		newEventId: () => crypto.randomUUID(),
		eventsCommitted: () => {},
		jobs: plugins.jobs,
		newJobId: () => crypto.randomUUID(),
		jobsCommitted: () => {},
	});
	const delivery = createEventDelivery({
		...sources,
		cancellation: database.cancellation,
		hasCoreSchema: () => true,
		handlerTimeout: { ms: 10_000, setTimer: setSystemTimer },
	});
	return {
		failures: plugins.failures,
		addEntry: () =>
			pipeline.invoke({
				operation: "ledger.addEntry",
				actor: ALICE,
				apiTokenId: null,
				idempotencyKey: null,
				workspace: WORKSPACE,
				input: { amount: 5 },
				correlationId: "request-1",
			}),
		deliverEvents: () => delivery.deliverDue(NOT_STOPPED),
		stop: () => plugins.deactivate(),
	};
}

function failingToActivate(plugin: PluginPackage): PluginPackage {
	return {
		...plugin,
		loadDefinition: async () => ({
			...z.looseObject({}).parse(await plugin.loadDefinition()),
			activate: async () => {
				throw new Error("the statistics store is unreachable");
			},
		}),
	};
}

const statisticsWithoutCapability: PluginPackage = {
	packageName: "@workbench/plugin-statistics",
	pluginName: "statistics",
	version: "1.0.0",
	loadDefinition: async () =>
		definePlugin({
			manifest: { name: "statistics" },
			subscriptions: [
				defineEventSubscription({ event: entryAdded, handle: async () => {} }),
			],
		}),
};

function recordingForecastRequiringWeather() {
	const received: EntryAdded[] = [];
	const plugin: PluginPackage = {
		packageName: "@workbench/plugin-forecast",
		pluginName: "forecast",
		version: "1.0.0",
		loadDefinition: async () =>
			definePlugin({
				manifest: {
					name: "forecast",
					requires: { weather: "^1.0.0" },
					capabilities: [eventSubscriptionCapability(entryAdded)],
				},
				subscriptions: [
					defineEventSubscription({
						event: entryAdded,
						handle: async (event) => {
							received.push(event);
						},
					}),
				],
			}),
	};
	return { plugin, received };
}

const weather: PluginPackage = {
	packageName: "@workbench/plugin-weather",
	pluginName: "weather",
	version: "1.0.0",
	loadDefinition: async () => definePlugin({ manifest: { name: "weather" } }),
};

async function start(
	plugins: readonly PluginPackage[],
	options: Omit<OperationHarnessOptions, "plugins"> = {},
): Promise<OperationHarness> {
	const harness = await startOperationHarness({ ...options, plugins });
	harnesses.push(harness);
	return harness;
}

function addingEntry(workspace: string, amount: number) {
	return calling(workspace, "ledger.addEntry", { amount });
}

function calling(workspace: string, operation: string, input: unknown) {
	return { actor: ALICE, workspace, operation, input };
}

const addedEntry = z.object({
	ok: z.literal(true),
	output: z.object({ id: z.string() }),
});

async function addEntryTo(
	harness: OperationHarness,
	workspace: string,
	amount: number,
): Promise<string> {
	const added = await harness.call(addingEntry(workspace, amount));
	return addedEntry.parse(added).output.id;
}

function deliveryFailures(harness: OperationHarness) {
	return harness.logEntries.filter(
		(entry) => entry.message === "event not delivered",
	);
}

describe("an event a mutation publishes", () => {
	test("reaches the handler of a plugin that subscribed to it, with id, time, version, workspace and payload", async () => {
		const statistics = recording("statistics");
		const harness = await start([ledger, statistics.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		const entryId = await addEntryTo(harness, workspace, 5);
		await harness.deliverEvents();

		expect(statistics.received).toEqual([
			{
				id: "00000000-0000-4000-e000-000000000001",
				name: "ledger.EntryAdded",
				version: 1,
				occurredAt: new Date("2026-11-26T08:00:00.000Z"),
				workspace,
				payload: { entryId },
			},
		]);
		expect(harness.logEntries).toContainEqual({
			time: "2026-11-26T08:00:00.000Z",
			level: "debug",
			message: "event delivered",
			eventId: "00000000-0000-4000-e000-000000000001",
			event: "ledger.EntryAdded",
			subscriber: "statistics",
		});
	});

	test("is never delivered when the mutation is rolled back", async () => {
		const statistics = recording("statistics");
		const harness = await start([ledger, statistics.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		const added = await harness.call(addingEntry(workspace, -5));
		await harness.deliverEvents();

		expect(added).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
		expect(statistics.received).toEqual([]);
	});

	test("is handled in a transaction on the schema of the subscribing plugin", async () => {
		const harness = await start([
			ledger,
			tally(async (event, ctx) => {
				await ctx.sql`INSERT INTO tallied_entries (event_id, entry_id) VALUES (${event.id}, ${event.payload.entryId})`;
			}),
		]);
		const workspace = await harness.createWorkspace("Alpha");

		const entryId = await addEntryTo(harness, workspace, 5);
		await harness.deliverEvents();

		expect(
			await harness.call(calling(workspace, "tally.listTallied", {})),
		).toEqual({ ok: true, output: { entryIds: [entryId] } });
	});

	test("reaches each subscribing plugin once, however often events are delivered", async () => {
		const statistics = recording("statistics");
		const search = recording("search");
		const harness = await start([ledger, statistics.plugin, search.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		await harness.call(addingEntry(workspace, 5));
		await harness.call(addingEntry(workspace, 6));
		await harness.deliverEvents();
		await harness.deliverEvents();

		const delivered = [
			"00000000-0000-4000-e000-000000000001",
			"00000000-0000-4000-e000-000000000002",
		];
		expect(statistics.received.map((event) => event.id)).toEqual(delivered);
		expect(search.received.map((event) => event.id)).toEqual(delivered);
	});
});

describe("an event whose handler fails", () => {
	test("is delivered again with the same id once its retry is due, and tells the operator why it failed", async () => {
		const clock = adjustableClock("2026-11-27T09:00:00.000Z");
		const attempts: string[] = [];
		const flaky = subscriber("flaky", async (event) => {
			attempts.push(event.id);
			if (attempts.length <= 2) throw new Error("the index is locked");
		});
		const harness = await start([ledger, flaky], { now: clock.now });
		const workspace = await harness.createWorkspace("Alpha");
		await harness.call(addingEntry(workspace, 5));

		await harness.deliverEvents();
		await harness.deliverEvents();
		const attemptsBeforeRetryIsDue = attempts.length;
		clock.advanceBy(ONE_HOUR_MS);
		await harness.deliverEvents();
		clock.advanceBy(ONE_HOUR_MS);
		await harness.deliverEvents();
		clock.advanceBy(ONE_HOUR_MS);
		await harness.deliverEvents();

		const event = "00000000-0000-4000-e000-000000000001";
		expect(attemptsBeforeRetryIsDue).toBe(1);
		expect(attempts).toEqual([event, event, event]);
		expect(deliveryFailures(harness)).toEqual([
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "error",
				message: "event not delivered",
				eventId: event,
				event: "ledger.EntryAdded",
				subscriber: "flaky",
				reason: "handler_threw",
				error: expect.objectContaining({
					name: "Error",
					message: "the index is locked",
				}),
				attempt: 1,
				retryInMs: 500,
			},
			expect.objectContaining({ eventId: event, attempt: 2, retryInMs: 1000 }),
		]);
	});

	test("still reaches the other subscribing plugins and takes later events to the failing one", async () => {
		const statistics = recording("statistics");
		const handled: string[] = [];
		const refused: string[] = [];
		const choosy = subscriber("choosy", async (event) => {
			if (refused.includes(event.payload.entryId))
				throw new Error("not this one");
			handled.push(event.payload.entryId);
		});
		const harness = await start([ledger, choosy, statistics.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		const refusedEntry = await addEntryTo(harness, workspace, 5);
		refused.push(refusedEntry);
		const laterEntry = await addEntryTo(harness, workspace, 6);
		await harness.deliverEvents();

		expect(statistics.received.map((event) => event.payload.entryId)).toEqual([
			refusedEntry,
			laterEntry,
		]);
		expect(handled).toEqual([laterEntry]);
	});

	test("leaves nothing behind of what the failed handler wrote", async () => {
		const clock = adjustableClock("2026-11-27T09:00:00.000Z");
		let attempts = 0;
		const harness = await start(
			[
				ledger,
				tally(async (event, ctx) => {
					attempts += 1;
					await ctx.sql`INSERT INTO tallied_entries (event_id, entry_id) VALUES (${ctx.newId()}, ${event.payload.entryId})`;
					if (attempts === 1) throw new Error("failed after writing");
				}),
			],
			{ now: clock.now },
		);
		const workspace = await harness.createWorkspace("Alpha");
		const entryId = await addEntryTo(harness, workspace, 5);

		await harness.deliverEvents();
		clock.advanceBy(ONE_HOUR_MS);
		await harness.deliverEvents();

		expect(
			await harness.call(calling(workspace, "tally.listTallied", {})),
		).toEqual({ ok: true, output: { entryIds: [entryId] } });
	});

	test("is not handed a payload that the event definition of the subscribing plugin rejects", async () => {
		const received: unknown[] = [];
		const strict: PluginPackage = {
			packageName: "@workbench/plugin-strict",
			pluginName: "strict",
			version: "1.0.0",
			loadDefinition: async () =>
				definePlugin({
					manifest: {
						name: "strict",
						capabilities: [eventSubscriptionCapability(entryAdded)],
					},
					subscriptions: [
						defineEventSubscription({
							event: defineEvent({
								...entryAdded,
								payload: z.object({
									entryId: z.string(),
									currency: z.string(),
								}),
							}),
							handle: async (event) => {
								received.push(event);
							},
						}),
					],
				}),
		};
		const harness = await start([ledger, strict]);
		const workspace = await harness.createWorkspace("Alpha");

		await harness.call(addingEntry(workspace, 5));
		await harness.deliverEvents();

		expect(received).toEqual([]);
		expect(deliveryFailures(harness)).toEqual([
			expect.objectContaining({
				subscriber: "strict",
				reason: "invalid_payload",
				issues: [expect.objectContaining({ path: ["currency"] })],
				attempt: 1,
			}),
		]);
	});
});

describe("an event published while a subscribing plugin has a load failure", () => {
	test("reaches the handler once the instance starts again with the plugin active", async () => {
		const database = await migratedDatabase();
		const statistics = recording("statistics");
		const beforeRestart = await startInstanceOn(database, [
			ledger,
			failingToActivate(statistics.plugin),
		]);
		const added = await beforeRestart.addEntry();
		await beforeRestart.deliverEvents();
		const receivedBeforeRestart = [...statistics.received];
		await beforeRestart.stop();

		const afterRestart = await startInstanceOn(database, [
			ledger,
			statistics.plugin,
		]);
		cleanups.push(async () => {
			await afterRestart.stop();
		});
		await afterRestart.deliverEvents();

		expect(beforeRestart.failures).toEqual([
			expect.objectContaining({
				plugin: "statistics",
				reason: "activation_failed",
			}),
		]);
		expect(added).toEqual(expect.objectContaining({ ok: true }));
		expect(receivedBeforeRestart).toEqual([]);
		expect(statistics.received).toEqual([
			expect.objectContaining({ name: "ledger.EntryAdded" }),
		]);
	});

	test("reaches each enabled plugin whose valid definition subscribed to it once that plugin is active, and never one whose definition was invalid", async () => {
		const database = await migratedDatabase();
		const statistics = recording("statistics");
		const reports = recording("reports");
		const forecast = recordingForecastRequiringWeather();
		const beforeRestart = await startInstanceOn(database, [
			ledger,
			statisticsWithoutCapability,
			failingToActivate(reports.plugin),
			forecast.plugin,
		]);
		const added = await beforeRestart.addEntry();
		await beforeRestart.stop();

		const afterRestart = await startInstanceOn(database, [
			ledger,
			statistics.plugin,
			reports.plugin,
			weather,
			forecast.plugin,
		]);
		cleanups.push(async () => {
			await afterRestart.stop();
		});
		await afterRestart.deliverEvents();

		const entryId = addedEntry.parse(added).output.id;
		expect(afterRestart.failures).toEqual([]);
		expect(reports.received.map((event) => event.payload)).toEqual([
			{ entryId },
		]);
		expect(forecast.received.map((event) => event.payload)).toEqual([
			{ entryId },
		]);
		expect(statistics.received).toEqual([]);
	});
});

describe("a mutation that publishes what it may not", () => {
	test.each([
		[
			"an event its plugin does not declare",
			"ledger.addEntryWithUndeclaredEvent",
			"UndeclaredEventError",
			'"ledger" published the event "ledger.EntryRemoved", which it does not declare among its events',
		],
		[
			"an event of another plugin",
			"ledger.addEntryWithForeignEvent",
			"UndeclaredEventError",
			'"ledger" published the event "billing.InvoiceSent", which it does not declare among its events',
		],
		[
			"a payload its event definition rejects",
			"ledger.addEntryWithMalformedEvent",
			"InvalidEventPayloadError",
			'the payload of the event "ledger.EntryAdded" does not match its payload schema',
		],
	])(
		"is rolled back and delivers nothing for %s",
		async (_case, operation, name, message) => {
			const statistics = recording("statistics");
			const harness = await start([ledger, billing, statistics.plugin]);
			const workspace = await harness.createWorkspace("Alpha");

			const added = await harness.call(
				calling(workspace, operation, { amount: 5 }),
			);
			await harness.deliverEvents();

			expect(added).toEqual({
				ok: false,
				failure: expect.objectContaining({ code: "internal_error" }),
			});
			expect(harness.logEntries).toContainEqual(
				expect.objectContaining({
					message: "operation failed",
					reason: "execute_threw",
					error: expect.objectContaining({ name, message }),
				}),
			);
			expect(
				await harness.call(calling(workspace, "ledger.countEntries", {})),
			).toEqual({ ok: true, output: { entries: 0 } });
			expect(statistics.received).toEqual([]);
		},
	);
});

describe("a query", () => {
	test("fails when it publishes an event, and delivers nothing", async () => {
		const statistics = recording("statistics");
		const harness = await start([ledger, statistics.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		const announced = await harness.call(
			calling(workspace, "ledger.announceCount", {}),
		);
		await harness.deliverEvents();

		expect(announced).toEqual({
			ok: false,
			failure: expect.objectContaining({ code: "internal_error" }),
		});
		expect(harness.logEntries).toContainEqual(
			expect.objectContaining({
				message: "operation failed",
				error: expect.objectContaining({
					name: "EventPublishedByQueryError",
					message:
						'the query "ledger.announceCount" published an event; only a mutation publishes events',
				}),
			}),
		);
		expect(statistics.received).toEqual([]);
	});
});

describe("the pipeline", () => {
	test.each([
		["once after a mutation that published an event", "ledger.addEntry", 5, 1],
		["not after a mutation that was rolled back", "ledger.addEntry", -5, 0],
		["not after a query", "ledger.countEntries", 5, 0],
	])(
		"tells the delivery that events were committed %s",
		async (_case, operation, amount, expected) => {
			let told = 0;
			const pipeline = await startLedgerPipeline(() => {
				told += 1;
			});

			await pipeline.invoke({
				operation,
				actor: ALICE,
				apiTokenId: null,
				idempotencyKey: null,
				workspace: WORKSPACE,
				input: { amount },
				correlationId: "request-1",
			});

			expect(told).toBe(expected);
		},
	);
});
