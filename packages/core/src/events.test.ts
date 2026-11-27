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
import { createFreshDatabase } from "./testing/postgres.ts";
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
	(ctx) => ctx.publish(entryAdded, { entryId: 7 as unknown as string }),
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
		random: () => 0.5,
		logger,
	});
}

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

		const added = await harness.call(addingEntry(workspace, 5));
		await harness.deliverEvents();

		expect(added).toEqual({
			ok: true,
			output: { id: "00000000-0000-4000-8000-000000000002" },
		});
		expect(statistics.received).toEqual([
			{
				id: "00000000-0000-4000-e000-000000000001",
				name: "ledger.EntryAdded",
				version: 1,
				occurredAt: new Date("2026-11-26T08:00:00.000Z"),
				workspace,
				payload: { entryId: "00000000-0000-4000-8000-000000000002" },
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

		await harness.call(addingEntry(workspace, 5));
		await harness.deliverEvents();

		expect(
			await harness.call(calling(workspace, "tally.listTallied", {})),
		).toEqual({
			ok: true,
			output: { entryIds: ["00000000-0000-4000-8000-000000000002"] },
		});
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
		const choosy = subscriber("choosy", async (event) => {
			if (event.id.endsWith("1")) throw new Error("not this one");
			handled.push(event.id);
		});
		const harness = await start([ledger, choosy, statistics.plugin]);
		const workspace = await harness.createWorkspace("Alpha");

		await harness.call(addingEntry(workspace, 5));
		await harness.call(addingEntry(workspace, 6));
		await harness.deliverEvents();

		expect(statistics.received.map((event) => event.id)).toEqual([
			"00000000-0000-4000-e000-000000000001",
			"00000000-0000-4000-e000-000000000002",
		]);
		expect(handled).toEqual(["00000000-0000-4000-e000-000000000002"]);
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
		await harness.call(addingEntry(workspace, 5));

		await harness.deliverEvents();
		clock.advanceBy(ONE_HOUR_MS);
		await harness.deliverEvents();

		expect(
			await harness.call(calling(workspace, "tally.listTallied", {})),
		).toEqual({
			ok: true,
			output: { entryIds: ["00000000-0000-4000-8000-000000000002"] },
		});
	});

	test("has its effect outside the database once when the handler names the event id as idempotency key", async () => {
		const clock = adjustableClock("2026-11-27T09:00:00.000Z");
		const mailGateway = new Map<string, string>();
		let attempts = 0;
		const notifier = subscriber("notifier", async (event) => {
			attempts += 1;
			if (!mailGateway.has(event.id))
				mailGateway.set(event.id, `entry ${event.payload.entryId} was added`);
			if (attempts === 1) throw new Error("crashed after sending");
		});
		const harness = await start([ledger, notifier], { now: clock.now });
		const workspace = await harness.createWorkspace("Alpha");
		await harness.call(addingEntry(workspace, 5));

		await harness.deliverEvents();
		clock.advanceBy(ONE_HOUR_MS);
		await harness.deliverEvents();

		expect(attempts).toBe(2);
		expect([...mailGateway]).toEqual([
			[
				"00000000-0000-4000-e000-000000000001",
				"entry 00000000-0000-4000-8000-000000000002 was added",
			],
		]);
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
				workspace: WORKSPACE,
				input: { amount },
				correlationId: "request-1",
			});

			expect(told).toBe(expected);
		},
	);
});
