import { afterEach, describe, expect, test } from "bun:test";
import {
	defineEvent,
	defineEventSubscription,
	type EventDefinition,
	type EventSubscription,
	eventSubscriptionCapability,
	type SchemaResult,
} from "@workbench/sdk";
import { SQL } from "bun";
import { z } from "zod";
import { Secret } from "./config.ts";
import { startEventDeliveryLoop } from "./event-delivery-loop.ts";
import { createEventDelivery, recordEvent } from "./event-outbox.ts";
import {
	type EventParticipant,
	type EventRegistry,
	readEvents,
	readSubscriptions,
	registerEvents,
} from "./event-registry.ts";
import {
	type HookTimeout,
	type SetTimer,
	setSystemTimer,
} from "./hook-timeout.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	migrateCoreSchema,
} from "./schema-migrations.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";
import { type LogEntry, recordingLogger } from "./testing/recording-logger.ts";
import { createWorkspace } from "./workspaces.ts";

const NOW = new Date("2026-11-27T09:00:00.000Z");

const LATER = new Date("2026-11-27T10:00:00.000Z");

const WORKSPACE = "00000000-0000-4000-8000-00000000aaaa";

const NOT_STOPPED = new AbortController().signal;

const NEVER_EXPIRING: HookTimeout = { ms: 10_000, setTimer: () => () => {} };

const labelRenamed = defineEvent({
	plugin: "board",
	name: "LabelRenamed",
	version: 1,
	payload: z.object({ labelId: z.string() }),
});

type LabelRenamedHandler = EventSubscription<{ labelId: string }>["handle"];

function subscribing(
	subscriber: string,
	event: EventDefinition<{ labelId: string }>,
	handle: LabelRenamedHandler,
): EventParticipant {
	return {
		events: [],
		subscriptions: readSubscriptions(
			subscriber,
			[defineEventSubscription({ event, handle })],
			[eventSubscriptionCapability(event)],
		).value,
	};
}

function subscription(
	subscriber: string,
	handle: LabelRenamedHandler,
): EventParticipant {
	return subscribing(subscriber, labelRenamed, handle);
}

function registryOf(
	...subscribers: readonly EventParticipant[]
): EventRegistry {
	const board: EventParticipant = {
		events: readEvents("board", [labelRenamed]).value,
		subscriptions: [],
	};
	return registerEvents([board, ...subscribers]);
}

const labelRenamedWithBrokenSchema = defineEvent({
	...labelRenamed,
	payload: {
		"~standard": {
			version: 1,
			vendor: "broken",
			validate: (): SchemaResult<{ labelId: string }> => {
				throw new Error("the schema is broken");
			},
		},
	},
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	cleanups.push(() => database.drop());
	return database;
}

async function migratedDatabase(): Promise<FreshDatabase> {
	const database = await freshDatabase();
	await migrateCoreSchema(
		{
			databaseUrl: new Secret(database.url),
			connectionTimeoutMs: 10_000,
			statementTimeoutMs: 60_000,
			lockRetryDelayMs: () => 0,
			setTimer: setSystemTimer,
			logger: recordingLogger().logger,
		},
		CORE_MIGRATIONS_DIRECTORY,
		new AbortController().signal,
	);
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Alpha",
		createdAt: NOW,
	});
	return database;
}

async function publishLabelRenamed(
	sql: SQL,
	events: EventRegistry,
	id: string,
): Promise<void> {
	await sql.begin((transaction) =>
		recordEvent(transaction, events, {
			id,
			publisher: "board",
			definition: labelRenamed,
			payload: { labelId: "label-1" },
			occurredAt: NOW,
			workspace: WORKSPACE,
		}),
	);
}

type DeliveryScenario = {
	readonly sql: SQL;
	readonly events: EventRegistry;
	readonly now?: () => Date;
	readonly random?: () => number;
	readonly handlerTimeout?: HookTimeout;
};

function deliveryOf(scenario: DeliveryScenario) {
	const { logger, entries } = recordingLogger();
	const delivery = createEventDelivery({
		sql: scenario.sql,
		events: scenario.events,
		now: scenario.now ?? (() => NOW),
		newId: () => "00000000-0000-4000-8000-000000000001",
		random: scenario.random ?? (() => 0.5),
		handlerTimeout: scenario.handlerTimeout ?? NEVER_EXPIRING,
		logger,
	});
	return { delivery, entries };
}

async function createSearchSchema(sql: SQL): Promise<void> {
	await sql.unsafe(`
		CREATE SCHEMA plugin_search;
		CREATE TABLE plugin_search.indexed_labels (event_id uuid PRIMARY KEY);
		CREATE TABLE plugin_search.label_owners (
			event_id uuid PRIMARY KEY
				REFERENCES plugin_search.indexed_labels (event_id)
				DEFERRABLE INITIALLY DEFERRED
		);
	`);
}

async function indexedLabels(sql: SQL): Promise<unknown[]> {
	const rows: unknown[] =
		await sql`SELECT event_id FROM plugin_search.indexed_labels ORDER BY event_id`;
	return [...rows];
}

function failuresIn(entries: readonly LogEntry[]): LogEntry[] {
	return entries.filter((entry) => entry.message === "event not delivered");
}

function manualTimer() {
	let expire: (() => void) | undefined;
	let announce: (() => void) | undefined;
	const setTimer: SetTimer = (onExpire) => {
		expire = onExpire;
		announce?.();
		return () => {
			expire = undefined;
		};
	};
	return {
		setTimer,
		set: () =>
			new Promise<void>((resolve) => {
				announce = resolve;
			}),
		expire: () => {
			if (expire === undefined) throw new Error("no timer is pending");
			expire();
		},
	};
}

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

const EVENT = "00000000-0000-4000-e000-000000000001";

const LATER_EVENT = "00000000-0000-4000-e000-000000000002";

describe("event delivery", () => {
	test("gives up on a handler that does not finish in time and delivers the event again once its retry is due", async () => {
		const database = await migratedDatabase();
		const timer = manualTimer();
		let attempts = 0;
		let now = NOW;
		const events = registryOf(
			subscription("search", () => {
				attempts += 1;
				return attempts === 1 ? new Promise(() => {}) : Promise.resolve();
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			events,
			now: () => now,
			handlerTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const delivering = delivery.deliverDue(NOT_STOPPED);
		await timerSet;
		timer.expire();
		await delivering;
		now = LATER;
		await delivery.deliverDue(NOT_STOPPED);
		await delivery.deliverDue(NOT_STOPPED);

		expect(attempts).toBe(2);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({
				eventId: EVENT,
				event: "board.LabelRenamed",
				subscriber: "search",
				reason: "handler_timed_out",
				timeoutMs: 250,
				attempt: 1,
				retryInMs: 500,
			}),
		]);
	});

	test("tells the operator the wait it stored for the retry, though every draw of the jitter differs", async () => {
		const database = await migratedDatabase();
		let attempts = 0;
		let now = NOW;
		let draws = 0;
		const events = registryOf(
			subscription("search", async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("the index is locked");
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			events,
			now: () => now,
			random: () => {
				draws += 1;
				return draws / 4;
			},
		});

		await delivery.deliverDue(NOT_STOPPED);
		now = new Date(NOW.getTime() + 249);
		await delivery.deliverDue(NOT_STOPPED);
		const attemptsBeforeTheWaitIsOver = attempts;
		now = new Date(NOW.getTime() + 250);
		await delivery.deliverDue(NOT_STOPPED);

		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ attempt: 1, retryInMs: 250 }),
		]);
		expect(attemptsBeforeTheWaitIsOver).toBe(1);
		expect(attempts).toBe(2);
	});

	test("keeps an event for a subscribing plugin that is not active and delivers it once the plugin is active again", async () => {
		const database = await migratedDatabase();
		const handled: string[] = [];
		const withSearch = registryOf(
			subscription("search", async (event) => {
				handled.push(event.id);
			}),
		);
		await publishLabelRenamed(database.sql, withSearch, EVENT);

		await deliveryOf({
			sql: database.sql,
			events: registryOf(subscription("statistics", async () => {})),
		}).delivery.deliverDue(NOT_STOPPED);
		const handledWhileInactive = [...handled];
		await deliveryOf({
			sql: database.sql,
			events: withSearch,
		}).delivery.deliverDue(NOT_STOPPED);

		expect(handledWhileInactive).toEqual([]);
		expect(handled).toEqual([EVENT]);
	});

	test("asks Postgres for nothing while no plugin subscribes to an event, so it may run before the core schema exists", async () => {
		const database = await freshDatabase();
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			events: registerEvents([]),
		});

		await delivery.deliverDue(NOT_STOPPED);

		expect(entries).toEqual([]);
	});

	test("hands an event to its handler once when two deliveries run at the same time", async () => {
		const database = await migratedDatabase();
		const second = new SQL(database.url, { max: 1 });
		cleanups.push(() => second.close());
		const entered = deferred();
		const release = deferred();
		const handled: string[] = [];
		const events = registryOf(
			subscription("search", async (event) => {
				handled.push(event.id);
				entered.resolve();
				await release.promise;
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);

		const first = deliveryOf({
			sql: database.sql,
			events,
		}).delivery.deliverDue(NOT_STOPPED);
		await entered.promise;
		await deliveryOf({ sql: second, events }).delivery.deliverDue(NOT_STOPPED);
		release.resolve();
		await first;

		expect(handled).toEqual([EVENT]);
	});

	test("attempts no further delivery once it is told to stop, and leaves the rest for the next run", async () => {
		const database = await migratedDatabase();
		const stopping = new AbortController();
		const handled: string[] = [];
		const events = registryOf(
			subscription("search", async (event) => {
				handled.push(event.id);
				stopping.abort();
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		await publishLabelRenamed(database.sql, events, LATER_EVENT);
		const { delivery } = deliveryOf({ sql: database.sql, events });

		await delivery.deliverDue(stopping.signal);
		const handledUntilStopped = [...handled];
		await delivery.deliverDue(NOT_STOPPED);

		expect(handledUntilStopped).toEqual([EVENT]);
		expect(handled).toEqual([EVENT, LATER_EVENT]);
	});
});

describe("a delivery that fails outside its handler", () => {
	test("counts the attempt, waits for its retry and still delivers later events when its transaction cannot be committed", async () => {
		const database = await migratedDatabase();
		await createSearchSchema(database.sql);
		const attempted: string[] = [];
		const events = registryOf(
			subscription("search", async (event, ctx) => {
				attempted.push(event.id);
				if (event.id === EVENT)
					await ctx.sql`INSERT INTO label_owners (event_id) VALUES (${event.id})`;
				else
					await ctx.sql`INSERT INTO indexed_labels (event_id) VALUES (${event.id})`;
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		await publishLabelRenamed(database.sql, events, LATER_EVENT);
		const { delivery, entries } = deliveryOf({ sql: database.sql, events });

		await delivery.deliverDue(NOT_STOPPED);
		await delivery.deliverDue(NOT_STOPPED);

		expect(attempted).toEqual([EVENT, LATER_EVENT]);
		expect(await indexedLabels(database.sql)).toEqual([
			{ event_id: LATER_EVENT },
		]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({
				eventId: EVENT,
				event: "board.LabelRenamed",
				subscriber: "search",
				reason: "delivery_failed",
				error: expect.objectContaining({ name: "PostgresError" }),
				attempt: 1,
				retryInMs: 500,
			}),
		]);
	});

	test("is not blamed on the handler when the payload schema of the subscribing plugin throws", async () => {
		const database = await migratedDatabase();
		const handled: string[] = [];
		const events = registryOf(
			subscribing("search", labelRenamedWithBrokenSchema, async (event) => {
				handled.push(event.id);
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({ sql: database.sql, events });

		await delivery.deliverDue(NOT_STOPPED);

		expect(handled).toEqual([]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({
				eventId: EVENT,
				reason: "delivery_failed",
				error: expect.objectContaining({ message: "the schema is broken" }),
				attempt: 1,
			}),
		]);
	});
});

describe("a handler that timed out", () => {
	test("leaves nothing behind of what it writes after its time is up", async () => {
		const database = await migratedDatabase();
		await createSearchSchema(database.sql);
		const timer = manualTimer();
		const timeIsUp = deferred();
		const lateWrite = Promise.withResolvers<"written" | "refused">();
		const events = registryOf(
			subscription("search", async (event, ctx) => {
				await timeIsUp.promise;
				await ctx.sql`INSERT INTO indexed_labels (event_id) VALUES (${event.id})`.then(
					() => lateWrite.resolve("written"),
					() => lateWrite.resolve("refused"),
				);
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			events,
			handlerTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const delivering = delivery.deliverDue(NOT_STOPPED);
		await timerSet;
		timer.expire();
		timeIsUp.resolve();
		await delivering;
		await lateWrite.promise;

		expect(await indexedLabels(database.sql)).toEqual([]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ reason: "handler_timed_out", attempt: 1 }),
		]);
	});
});

describe("the event delivery loop on the outbox", () => {
	test("delivers an event when it is woken, without waiting for its poll interval", async () => {
		const database = await migratedDatabase();
		const handled: string[] = [];
		const firstHandled = deferred();
		const events = registryOf(
			subscription("search", async (event) => {
				handled.push(event.id);
				firstHandled.resolve();
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery } = deliveryOf({ sql: database.sql, events });
		const loop = startEventDeliveryLoop({
			delivery,
			pollIntervalMs: 1_000,
			setTimer: () => () => {},
			logger: recordingLogger().logger,
		});
		cleanups.push(() => loop.stop());

		loop.wake();
		await firstHandled.promise;
		await loop.stop();
		await delivery.deliverDue(NOT_STOPPED);

		expect(handled).toEqual([EVENT]);
	});
});
