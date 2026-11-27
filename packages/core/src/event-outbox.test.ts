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
import { createEventDelivery, recordEvent } from "./event-outbox.ts";
import {
	type EventParticipant,
	type EventRegistry,
	readEvents,
	readSubscriptions,
	registerEvents,
} from "./event-registry.ts";
import { type HookTimeout, setSystemTimer } from "./hook-timeout.ts";
import { readMigrations } from "./migration-files.ts";
import { startPollLoop } from "./poll-loop.ts";
import {
	CORE_MIGRATIONS_DIRECTORY,
	type MigrationRunner,
	migrateCoreSchema,
	migrateSchemas,
} from "./schema-migrations.ts";
import { CORE_SCHEMA } from "./schema-name.ts";
import { manualTimer } from "./testing/manual-timer.ts";
import {
	createFreshDatabase,
	type FreshDatabase,
	PostgresGate,
	TEST_DATABASE_URL,
} from "./testing/postgres.ts";
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

function subscribing<Payload>(
	subscriber: string,
	event: EventDefinition<Payload>,
	handle: EventSubscription<Payload>["handle"],
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

function registryOfBoardPublishing<Payload>(
	event: EventDefinition<Payload>,
	...subscribers: readonly EventParticipant[]
): EventRegistry {
	const board: EventParticipant = {
		events: readEvents("board", [event]).value,
		subscriptions: [],
	};
	return registerEvents({ active: [board, ...subscribers], notActive: [] });
}

function registryOf(
	...subscribers: readonly EventParticipant[]
): EventRegistry {
	return registryOfBoardPublishing(labelRenamed, ...subscribers);
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

const labelRenamedWithStalledSchema = defineEvent({
	...labelRenamed,
	payload: {
		"~standard": {
			version: 1,
			vendor: "stalled",
			validate: () => new Promise<SchemaResult<{ labelId: string }>>(() => {}),
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

async function migratedDatabase(): Promise<FreshDatabase> {
	const database = await freshDatabase();
	await migrateCoreSchema(
		migrationRunner(database),
		CORE_MIGRATIONS_DIRECTORY,
		NOT_STOPPED,
	);
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Alpha",
		createdAt: NOW,
	});
	return database;
}

const FIRST_MIGRATION_OF_THE_EVENT_SEQUENCE = "0005";

async function databaseBeforeDeliveriesCarriedTheEventSequence(): Promise<FreshDatabase> {
	const database = await freshDatabase();
	const migrations = await readMigrations(CORE_MIGRATIONS_DIRECTORY);
	await migrateSchemas(
		migrationRunner(database),
		[
			{
				schema: CORE_SCHEMA,
				migrations: migrations.filter(
					({ name }) => name < FIRST_MIGRATION_OF_THE_EVENT_SEQUENCE,
				),
			},
		],
		NOT_STOPPED,
	);
	await createWorkspace(database.sql, {
		id: WORKSPACE,
		name: "Alpha",
		createdAt: NOW,
	});
	return database;
}

async function recordLabelRenamedBeforeTheEventSequence(
	sql: SQL,
	id: string,
): Promise<void> {
	await sql`
		INSERT INTO core.events (id, name, version, occurred_at, workspace_id, payload)
		VALUES (${id}, 'board.LabelRenamed', 1, ${NOW}, ${WORKSPACE}, ${{ labelId: "label-1" }})`;
	await sql`
		INSERT INTO core.event_deliveries (event_id, subscriber, next_attempt_at)
		VALUES (${id}, 'search', ${NOW})`;
}

async function publish<Payload>(
	{ sql, events }: Pick<DeliveryScenario, "sql" | "events">,
	definition: EventDefinition<Payload>,
	payload: Payload,
): Promise<void> {
	await sql.begin((transaction) =>
		recordEvent(transaction, events, {
			id: EVENT,
			publisher: "board",
			definition,
			payload,
			occurredAt: NOW,
			workspace: WORKSPACE,
		}),
	);
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

async function deliveredPayloads<Payload>(
	database: FreshDatabase,
	definition: EventDefinition<Payload>,
	payload: Payload,
): Promise<Payload[]> {
	const received: Payload[] = [];
	const events = registryOfBoardPublishing(
		definition,
		subscribing("search", definition, async (event) => {
			received.push(event.payload);
		}),
	);
	const { sql } = database;
	await publish({ sql, events }, definition, payload);
	await deliveryOf({
		sql,
		cancellation: database.cancellation,
		events,
	}).delivery.deliverDue(NOT_STOPPED);
	return received;
}

function boardEvent<Payload>(
	payload: EventDefinition<Payload>["payload"],
): EventDefinition<Payload> {
	return defineEvent({ plugin: "board", name: "CardDue", version: 1, payload });
}

const HANDLER_LOCK = 4711;

async function connectionHoldingTheHandlerLock(
	database: FreshDatabase,
): Promise<SQL> {
	const connection = new SQL(database.url, { max: 1 });
	cleanups.push(() => connection.close());
	await connection`SELECT pg_advisory_lock(${HANDLER_LOCK})`;
	return connection;
}

async function untilAStatementWaitsForTheLock(observer: SQL): Promise<void> {
	let waiting: unknown[] = [];
	while (waiting.length === 0)
		waiting = await observer`
			SELECT FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`;
}

function waitingForTheLock(): EventParticipant {
	return subscription("search", async (_event, ctx) => {
		await ctx.sql`SELECT pg_advisory_xact_lock(${HANDLER_LOCK})`;
	});
}

function cancellationBehindAGate(database: FreshDatabase): {
	readonly gate: PostgresGate;
	readonly cancellation: SQL;
} {
	const gate = PostgresGate.create(database.url);
	gate.forward();
	const cancellation = new SQL(gate.url, { max: 1, prepare: false });
	cleanups.push(async () => {
		gate.release();
		await cancellation.close();
		gate.close();
	});
	return { gate, cancellation };
}

async function refuseNewConnections(database: FreshDatabase): Promise<void> {
	const name = new URL(database.url).pathname.slice(1);
	const admin = new SQL(TEST_DATABASE_URL, { max: 1 });
	try {
		await admin.unsafe(`ALTER DATABASE ${name} ALLOW_CONNECTIONS false`);
	} finally {
		await admin.close();
	}
}

function poolOfAnInstance(database: FreshDatabase): SQL {
	const pool = new SQL(database.url, {
		connectionTimeout: 10,
		connection: { statement_timeout: 60_000 },
	});
	cleanups.push(() => pool.close());
	return pool;
}

async function attemptsOf(sql: SQL, eventId: string): Promise<unknown[]> {
	const rows: unknown[] =
		await sql`SELECT attempts FROM core.event_deliveries WHERE event_id = ${eventId}`;
	return [...rows];
}

type DeliveryScenario = {
	readonly sql: SQL;
	readonly cancellation: SQL;
	readonly events: EventRegistry;
	readonly now?: () => Date;
	readonly random?: () => number;
	readonly handlerTimeout?: HookTimeout;
	readonly hasCoreSchema?: () => boolean;
};

function deliveryOf(scenario: DeliveryScenario) {
	const { logger, entries } = recordingLogger();
	const delivery = createEventDelivery({
		sql: scenario.sql,
		cancellation: scenario.cancellation,
		events: scenario.events,
		hasCoreSchema: scenario.hasCoreSchema ?? (() => true),
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

function adjustableClock(start: Date) {
	let current = start;
	return {
		now: () => current,
		advanceBy: (ms: number) => {
			current = new Date(current.getTime() + ms);
		},
	};
}

const ONE_HOUR_MS = 3_600_000;

const JUST_UNDER_THE_LONGEST_WAIT_MS = 299_700;

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
		const started = Promise.withResolvers<void>();
		const database = await migratedDatabase();
		const timer = manualTimer();
		let attempts = 0;
		let now = NOW;
		const events = registryOf(
			subscription("search", () => {
				attempts += 1;
				started.resolve();
				return attempts === 1 ? new Promise(() => {}) : Promise.resolve();
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
			now: () => now,
			handlerTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const delivering = delivery.deliverDue(NOT_STOPPED);
		await timerSet;
		await started.promise;
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

	test("gives up on a payload schema that does not finish validating in time, as on a handler", async () => {
		const database = await migratedDatabase();
		const timer = manualTimer();
		const handled: string[] = [];
		const events = registryOf(
			subscribing("search", labelRenamedWithStalledSchema, async (event) => {
				handled.push(event.id);
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
			handlerTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const delivering = delivery.deliverDue(NOT_STOPPED);
		await timerSet;
		timer.expire();
		await delivering;

		expect(handled).toEqual([]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({
				eventId: EVENT,
				reason: "handler_timed_out",
				timeoutMs: 250,
				attempt: 1,
			}),
		]);
	});

	test("does not start a handler whose payload schema finishes validating after its time is up", async () => {
		const database = await migratedDatabase();
		const timer = manualTimer();
		const validation =
			Promise.withResolvers<SchemaResult<{ labelId: string }>>();
		const handled: string[] = [];
		const events = registryOf(
			subscribing(
				"search",
				defineEvent({
					...labelRenamed,
					payload: {
						"~standard": {
							version: 1,
							vendor: "slow",
							validate: () => validation.promise,
						},
					},
				}),
				async (event) => {
					handled.push(event.id);
				},
			),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
			handlerTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const delivering = delivery.deliverDue(NOT_STOPPED);
		await timerSet;
		timer.expire();
		await delivering;
		validation.resolve({ value: { labelId: "label-1" } });
		await database.sql`SELECT 1`;

		expect(handled).toEqual([]);
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
			cancellation: database.cancellation,
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

	test("never waits longer for a retry than five minutes, however often the handler has failed", async () => {
		const database = await migratedDatabase();
		const clock = adjustableClock(NOW);
		let attempts = 0;
		const events = registryOf(
			subscription("search", async () => {
				attempts += 1;
				throw new Error("the index is locked");
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
			now: clock.now,
			random: () => 0.999,
		});

		for (let failed = 0; failed < 10; failed += 1) {
			await delivery.deliverDue(NOT_STOPPED);
			clock.advanceBy(ONE_HOUR_MS);
		}
		await delivery.deliverDue(NOT_STOPPED);
		clock.advanceBy(JUST_UNDER_THE_LONGEST_WAIT_MS - 1);
		await delivery.deliverDue(NOT_STOPPED);
		const attemptsBeforeTheWaitIsOver = attempts;
		clock.advanceBy(1);
		await delivery.deliverDue(NOT_STOPPED);

		expect(
			failuresIn(entries).map(({ attempt, retryInMs }) => ({
				attempt,
				retryInMs,
			})),
		).toEqual([
			{ attempt: 1, retryInMs: 999 },
			{ attempt: 2, retryInMs: 1_998 },
			{ attempt: 3, retryInMs: 3_996 },
			{ attempt: 4, retryInMs: 7_992 },
			{ attempt: 5, retryInMs: 15_984 },
			{ attempt: 6, retryInMs: 31_968 },
			{ attempt: 7, retryInMs: 63_936 },
			{ attempt: 8, retryInMs: 127_872 },
			{ attempt: 9, retryInMs: 255_744 },
			{ attempt: 10, retryInMs: JUST_UNDER_THE_LONGEST_WAIT_MS },
			{ attempt: 11, retryInMs: JUST_UNDER_THE_LONGEST_WAIT_MS },
			{ attempt: 12, retryInMs: JUST_UNDER_THE_LONGEST_WAIT_MS },
		]);
		expect(attemptsBeforeTheWaitIsOver).toBe(11);
		expect(attempts).toBe(12);
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
			cancellation: database.cancellation,
			events: registryOf(subscription("statistics", async () => {})),
		}).delivery.deliverDue(NOT_STOPPED);
		const handledWhileInactive = [...handled];
		await deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events: withSearch,
		}).delivery.deliverDue(NOT_STOPPED);

		expect(handledWhileInactive).toEqual([]);
		expect(handled).toEqual([EVENT]);
	});

	test("asks Postgres for nothing until the core schema exists", async () => {
		const database = await freshDatabase();
		const { delivery } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events: registryOf(subscribing("search", labelRenamed, async () => {})),
			hasCoreSchema: () => false,
		});

		await expect(delivery.deliverDue(NOT_STOPPED)).resolves.toBeUndefined();
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
			cancellation: database.cancellation,
			events,
		}).delivery.deliverDue(NOT_STOPPED);
		await entered.promise;
		await deliveryOf({
			sql: second,
			cancellation: database.cancellation,
			events,
		}).delivery.deliverDue(NOT_STOPPED);
		release.resolve();
		await first;

		expect(handled).toEqual([EVENT]);
	});

	test("attempts the deliveries in the order in which their events were recorded, event by event across the subscribing plugins", async () => {
		const database = await migratedDatabase();
		const handled: string[] = [];
		const noting =
			(subscriber: string): LabelRenamedHandler =>
			async (event) => {
				handled.push(`${subscriber} ${event.id}`);
			};
		const events = registryOf(
			subscription("search", noting("search")),
			subscription("archive", noting("archive")),
		);
		await publishLabelRenamed(database.sql, events, LATER_EVENT);
		await publishLabelRenamed(database.sql, events, EVENT);

		await deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
		}).delivery.deliverDue(NOT_STOPPED);

		expect(handled).toEqual([
			`archive ${LATER_EVENT}`,
			`search ${LATER_EVENT}`,
			`archive ${EVENT}`,
			`search ${EVENT}`,
		]);
	});

	test("delivers the events that were recorded before a delivery carried the sequence of its event, in their order", async () => {
		const database = await databaseBeforeDeliveriesCarriedTheEventSequence();
		await recordLabelRenamedBeforeTheEventSequence(database.sql, LATER_EVENT);
		await recordLabelRenamedBeforeTheEventSequence(database.sql, EVENT);
		const handled: string[] = [];
		const events = registryOf(
			subscription("search", async (event) => {
				handled.push(event.id);
			}),
		);

		const migration = await migrateCoreSchema(
			migrationRunner(database),
			CORE_MIGRATIONS_DIRECTORY,
			NOT_STOPPED,
		);
		await deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
		}).delivery.deliverDue(NOT_STOPPED);

		expect(migration).toBe("migrated");
		expect(handled).toEqual([LATER_EVENT, EVENT]);
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
		const { delivery } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
		});

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
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
		});

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
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
		});

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
		const started = Promise.withResolvers<void>();
		const database = await migratedDatabase();
		await createSearchSchema(database.sql);
		const timer = manualTimer();
		const timeIsUp = deferred();
		const lateWrite = Promise.withResolvers<"written" | "refused">();
		const events = registryOf(
			subscription("search", async (event, ctx) => {
				started.resolve();
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
			cancellation: database.cancellation,
			events,
			handlerTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const delivering = delivery.deliverDue(NOT_STOPPED);
		await timerSet;
		await started.promise;
		timer.expire();
		await delivering;
		timeIsUp.resolve();

		expect(await lateWrite.promise).toBe("refused");
		expect(await indexedLabels(database.sql)).toEqual([]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ reason: "handler_timed_out", attempt: 1 }),
		]);
	});
});

describe("a handler whose time is up while a statement of it is running", () => {
	test.each([
		["a single connection", (database: FreshDatabase) => database.sql],
		["the pool an instance builds from its URL", poolOfAnInstance],
	])(
		"is given up at once on %s, its statement cancelled and the retry stored",
		async (_case, poolOf) => {
			const database = await migratedDatabase();
			const sql = poolOf(database);
			const observer = await connectionHoldingTheHandlerLock(database);
			const timer = manualTimer();
			const events = registryOf(waitingForTheLock());
			await publishLabelRenamed(sql, events, EVENT);
			const { delivery, entries } = deliveryOf({
				sql,
				cancellation: database.cancellation,
				events,
				handlerTimeout: { ms: 250, setTimer: timer.setTimer },
			});

			const timerSet = timer.set();
			const delivering = delivery.deliverDue(NOT_STOPPED);
			await timerSet;
			await untilAStatementWaitsForTheLock(observer);
			timer.expire();
			await delivering;

			expect(failuresIn(entries)).toEqual([
				expect.objectContaining({ reason: "handler_timed_out", attempt: 1 }),
			]);
			expect(await attemptsOf(sql, EVENT)).toEqual([{ attempts: 1 }]);
		},
	);

	test("is refused every further statement, so that the retry is stored while the lock it waited for is still held", async () => {
		const database = await migratedDatabase();
		const observer = await connectionHoldingTheHandlerLock(database);
		const { gate, cancellation } = cancellationBehindAGate(database);
		await cancellation`SELECT 1`;
		const timer = manualTimer();
		const furtherStatement = Promise.withResolvers<unknown>();
		const events = registryOf(
			subscription("search", async (_event, ctx) => {
				await ctx.sql`SAVEPOINT before_the_lock`;
				await ctx.sql`SELECT pg_advisory_xact_lock(${HANDLER_LOCK})`.catch(
					() => {},
				);
				furtherStatement.resolve(
					await ctx.sql`ROLLBACK TO SAVEPOINT before_the_lock`.then(
						() => "run",
						(error: unknown) => error,
					),
				);
				await ctx.sql`SELECT pg_advisory_xact_lock(${HANDLER_LOCK})`;
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation,
			events,
			handlerTimeout: { ms: 250, setTimer: timer.setTimer },
		});

		const timerSet = timer.set();
		const delivering = delivery.deliverDue(NOT_STOPPED);
		await timerSet;
		await untilAStatementWaitsForTheLock(observer);
		gate.holdResponses();
		timer.expire();
		const refusal = await furtherStatement.promise;
		gate.release();
		await delivering;

		expect(refusal).toMatchObject({ name: "StatementRefusedError" });
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ reason: "handler_timed_out", attempt: 1 }),
		]);
		expect(await attemptsOf(database.sql, EVENT)).toEqual([{ attempts: 1 }]);
	});

	test("is given up once the statement ends when the statement cannot be cancelled, and tells the operator why", async () => {
		const database = await migratedDatabase();
		const observer = await connectionHoldingTheHandlerLock(database);
		const timer = manualTimer();
		const events = registryOf(waitingForTheLock());
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
			handlerTimeout: { ms: 250, setTimer: timer.setTimer },
		});
		const notCancelled = () =>
			entries.filter((entry) => entry.message === "statement not cancelled");

		const timerSet = timer.set();
		const delivering = delivery.deliverDue(NOT_STOPPED);
		await timerSet;
		await untilAStatementWaitsForTheLock(observer);
		await refuseNewConnections(database);
		timer.expire();
		while (notCancelled().length === 0) await observer`SELECT 1`;
		await observer`SELECT pg_advisory_unlock(${HANDLER_LOCK})`;
		await delivering;

		expect(notCancelled()).toEqual([
			expect.objectContaining({
				eventId: EVENT,
				event: "board.LabelRenamed",
				subscriber: "search",
				error: expect.objectContaining({ name: "PostgresError" }),
			}),
		]);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({ reason: "handler_timed_out", attempt: 1 }),
		]);
	});
});

describe("the payload of an event", () => {
	test("is rejected when it is published if its schema does not accept what the outbox stores of it", async () => {
		const database = await migratedDatabase();
		const cardDue = boardEvent(z.date());
		const events = registryOfBoardPublishing(cardDue);

		const publishing = publish({ sql: database.sql, events }, cardDue, NOW);

		expect(await publishing.catch((error: unknown) => error)).toMatchObject({
			name: "InvalidEventPayloadError",
			issues: [{ path: [], message: expect.stringContaining("date") }],
		});
	});

	test("is rejected when it is published if its schema would change it again before the handler", async () => {
		const database = await migratedDatabase();
		const cardMoved = boardEvent(
			z.object({ lane: z.number().transform((lane) => lane * 2) }),
		);
		const events = registryOfBoardPublishing(cardMoved);

		const publishing = publish({ sql: database.sql, events }, cardMoved, {
			lane: 1,
		});

		expect(await publishing.catch((error: unknown) => error)).toMatchObject({
			name: "InvalidEventPayloadError",
			issues: [{ path: [], message: expect.stringContaining("changes") }],
		});
	});

	test("reaches the handler as its schema reads what the outbox stored of it", async () => {
		const database = await migratedDatabase();

		const delivered = await deliveredPayloads(
			database,
			boardEvent(z.coerce.date()),
			NOW,
		);

		expect(delivered).toEqual([NOW]);
	});

	test.each([
		["a number", 7],
		["a fraction", 1.5],
		["true", true],
		["false", false],
		["a string", "label-1"],
		["a string that reads as JSON", '{"labelId":7}'],
		["null", null],
		["a list", [7, "label-1", null]],
	])("reaches the handler unchanged when it is %s", async (_case, payload) => {
		const database = await migratedDatabase();

		const delivered = await deliveredPayloads(
			database,
			boardEvent<unknown>(z.unknown()),
			payload,
		);

		expect(delivered).toEqual([payload]);
	});
});

const DAY_MS = 86_400_000;

function removalsIn(entries: readonly LogEntry[]): LogEntry[] {
	return entries.filter((entry) => entry.message === "settled events removed");
}

async function countRows(sql: SQL): Promise<unknown> {
	const [row]: unknown[] = await sql`
		SELECT
			(SELECT count(*)::integer FROM core.events) AS events,
			(SELECT count(*)::integer FROM core.event_deliveries) AS deliveries`;
	return row;
}

async function insertLabelRenamedDeliveredAt(
	sql: SQL,
	deliveredAt: Date,
	count: number,
): Promise<void> {
	await sql`
		WITH recorded AS (
			INSERT INTO core.events (id, name, version, occurred_at, workspace_id, payload)
			SELECT gen_random_uuid(), 'board.LabelRenamed', 1, ${deliveredAt}, ${WORKSPACE}, '{"labelId": "label-1"}'::jsonb
			FROM generate_series(1, ${count})
			RETURNING id, sequence
		)
		INSERT INTO core.event_deliveries (event_id, event_sequence, subscriber, next_attempt_at, delivered_at)
		SELECT id, sequence, 'search', ${deliveredAt}, ${deliveredAt}
		FROM recorded`;
}

function searchSubscribing(): EventRegistry {
	return registryOf(subscription("search", async () => {}));
}

describe("a settled event", () => {
	test("is removed from the outbox with its deliveries 7 days after its last delivery, and not before", async () => {
		const database = await migratedDatabase();
		const events = searchSubscribing();
		await publishLabelRenamed(database.sql, events, EVENT);
		const at = (now: Date) =>
			deliveryOf({
				sql: database.sql,
				cancellation: database.cancellation,
				events,
				now: () => now,
			});
		await at(LATER).delivery.deliverDue(NOT_STOPPED);
		const justBefore = at(new Date(LATER.getTime() + 7 * DAY_MS - 1));
		const onTheDay = at(new Date(LATER.getTime() + 7 * DAY_MS));

		await justBefore.delivery.deliverDue(NOT_STOPPED);
		const rowsJustBefore = await countRows(database.sql);
		await onTheDay.delivery.deliverDue(NOT_STOPPED);

		expect(rowsJustBefore).toEqual({ events: 1, deliveries: 1 });
		expect(await countRows(database.sql)).toEqual({ events: 0, deliveries: 0 });
		expect(removalsIn(justBefore.entries)).toEqual([]);
		expect(removalsIn(onTheDay.entries)).toEqual([
			expect.objectContaining({ level: "debug", removed: 1 }),
		]);
	});

	test("is removed 7 days after it occurred when no plugin subscribed to it, and not before", async () => {
		const database = await migratedDatabase();
		const events = registryOfBoardPublishing(
			labelRenamed,
			subscribing("search", boardEvent(z.unknown()), async () => {}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const at = (now: Date) =>
			deliveryOf({
				sql: database.sql,
				cancellation: database.cancellation,
				events,
				now: () => now,
			});

		await at(new Date(NOW.getTime() + 7 * DAY_MS - 1)).delivery.deliverDue(
			NOT_STOPPED,
		);
		const rowsJustBefore = await countRows(database.sql);
		await at(new Date(NOW.getTime() + 7 * DAY_MS)).delivery.deliverDue(
			NOT_STOPPED,
		);

		expect(rowsJustBefore).toEqual({ events: 1, deliveries: 0 });
		expect(await countRows(database.sql)).toEqual({ events: 0, deliveries: 0 });
	});

	test("is removed in an instance where no active plugin subscribes to any event", async () => {
		const database = await migratedDatabase();
		const events = registryOfBoardPublishing(labelRenamed);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
			now: () => new Date(NOW.getTime() + 7 * DAY_MS),
		});

		await delivery.deliverDue(NOT_STOPPED);

		expect(await countRows(database.sql)).toEqual({ events: 0, deliveries: 0 });
	});
});

describe("an event with a delivery that is still open", () => {
	test("stays in the outbox with all its deliveries until its delivery deadline, however long ago the others were delivered", async () => {
		const database = await migratedDatabase();
		const archive = subscription("archive", async () => {});
		const search = subscription("search", async () => {});
		await publishLabelRenamed(database.sql, registryOf(search, archive), EVENT);
		const whileArchiveIsNotActive = (now: Date) =>
			deliveryOf({
				sql: database.sql,
				cancellation: database.cancellation,
				events: registryOf(search),
				now: () => now,
			});
		await whileArchiveIsNotActive(NOW).delivery.deliverDue(NOT_STOPPED);

		await whileArchiveIsNotActive(
			new Date(NOW.getTime() + DELIVERY_DEADLINE_MS - 1),
		).delivery.deliverDue(NOT_STOPPED);

		expect(await deliveriesOf(database.sql, EVENT)).toEqual([
			{
				subscriber: "archive",
				attempts: 0,
				delivered_at: null,
				dead_lettered_at: null,
				failure_reason: null,
			},
			{
				subscriber: "search",
				attempts: 0,
				delivered_at: NOW,
				dead_lettered_at: null,
				failure_reason: null,
			},
		]);
	});
});

const MOST_ATTEMPTS = 25;

const DELIVERY_DEADLINE_MS = 30 * DAY_MS;

async function deliveriesOf(sql: SQL, eventId: string): Promise<unknown[]> {
	const rows: unknown[] = await sql`
		SELECT subscriber, attempts, delivered_at, dead_lettered_at, failure_reason
		FROM core.event_deliveries
		WHERE event_id = ${eventId}
		ORDER BY subscriber`;
	return [...rows];
}

function deadLettersIn(entries: readonly LogEntry[]): LogEntry[] {
	return entries.filter((entry) => entry.message === "event dead-lettered");
}

function expiriesIn(entries: readonly LogEntry[]): LogEntry[] {
	return entries.filter(
		(entry) => entry.message === "event deliveries expired",
	);
}

async function insertLabelRenamedOpenFor(
	sql: SQL,
	subscriber: string,
	occurredAt: Date,
	count: number,
): Promise<void> {
	await sql`
		WITH recorded AS (
			INSERT INTO core.events (id, name, version, occurred_at, workspace_id, payload)
			SELECT gen_random_uuid(), 'board.LabelRenamed', 1, ${occurredAt}, ${WORKSPACE}, '{"labelId": "label-1"}'::jsonb
			FROM generate_series(1, ${count})
			RETURNING id, sequence
		)
		INSERT INTO core.event_deliveries (event_id, event_sequence, subscriber, next_attempt_at)
		SELECT id, sequence, ${subscriber}, ${occurredAt}
		FROM recorded`;
}

describe("a delivery whose handler keeps failing", () => {
	test("is dead-lettered with the reason of its last attempt after 25 attempts, and not attempted again", async () => {
		const database = await migratedDatabase();
		const clock = adjustableClock(NOW);
		let attempts = 0;
		const events = registryOf(
			subscription("search", async () => {
				attempts += 1;
				throw new Error("the index is locked");
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
			now: clock.now,
		});

		for (let run = 0; run <= MOST_ATTEMPTS; run += 1) {
			await delivery.deliverDue(NOT_STOPPED);
			clock.advanceBy(ONE_HOUR_MS);
		}

		expect(attempts).toBe(MOST_ATTEMPTS);
		expect(failuresIn(entries)).toHaveLength(MOST_ATTEMPTS - 1);
		expect(deadLettersIn(entries)).toEqual([
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "error",
				message: "event dead-lettered",
				eventId: EVENT,
				event: "board.LabelRenamed",
				subscriber: "search",
				reason: "handler_threw",
				error: expect.objectContaining({ message: "the index is locked" }),
				attempt: MOST_ATTEMPTS,
			},
		]);
		expect(await deliveriesOf(database.sql, EVENT)).toEqual([
			{
				subscriber: "search",
				attempts: MOST_ATTEMPTS,
				delivered_at: null,
				dead_lettered_at: new Date(
					NOW.getTime() + (MOST_ATTEMPTS - 1) * ONE_HOUR_MS,
				),
				failure_reason: "handler_threw",
			},
		]);
	});

	test("is dead-lettered when its last attempt fails outside its handler", async () => {
		const database = await migratedDatabase();
		const events = registryOf(
			subscribing("search", labelRenamedWithBrokenSchema, async () => {}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);
		await database.sql`
			UPDATE core.event_deliveries SET attempts = ${MOST_ATTEMPTS - 1}
			WHERE event_id = ${EVENT}`;
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
		});

		await delivery.deliverDue(NOT_STOPPED);

		expect(failuresIn(entries)).toEqual([]);
		expect(deadLettersIn(entries)).toEqual([
			expect.objectContaining({
				eventId: EVENT,
				reason: "delivery_failed",
				error: expect.objectContaining({ message: "the schema is broken" }),
				attempt: MOST_ATTEMPTS,
			}),
		]);
		expect(await deliveriesOf(database.sql, EVENT)).toEqual([
			expect.objectContaining({
				attempts: MOST_ATTEMPTS,
				dead_lettered_at: NOW,
				failure_reason: "delivery_failed",
			}),
		]);
	});
});

describe("a delivery that is still open when its delivery deadline has passed", () => {
	test("is dead-lettered as expired for a plugin that is not active, and the operator is told how many per subscriber", async () => {
		const database = await migratedDatabase();
		const archive = subscription("archive", async () => {});
		const search = subscription("search", async () => {});
		await publishLabelRenamed(database.sql, registryOf(search, archive), EVENT);
		await publishLabelRenamed(
			database.sql,
			registryOf(search, archive),
			LATER_EVENT,
		);
		const whileNeitherIsActive = (now: Date) =>
			deliveryOf({
				sql: database.sql,
				cancellation: database.cancellation,
				events: registryOf(subscription("statistics", async () => {})),
				now: () => now,
			});
		const justBefore = whileNeitherIsActive(
			new Date(NOW.getTime() + DELIVERY_DEADLINE_MS - 1),
		);
		const onTheDay = whileNeitherIsActive(
			new Date(NOW.getTime() + DELIVERY_DEADLINE_MS),
		);

		await justBefore.delivery.deliverDue(NOT_STOPPED);
		const openJustBefore = await deliveriesOf(database.sql, EVENT);
		await onTheDay.delivery.deliverDue(NOT_STOPPED);

		expect(openJustBefore).toEqual([
			expect.objectContaining({
				subscriber: "archive",
				dead_lettered_at: null,
			}),
			expect.objectContaining({ subscriber: "search", dead_lettered_at: null }),
		]);
		expect(await deliveriesOf(database.sql, EVENT)).toEqual([
			{
				subscriber: "archive",
				attempts: 0,
				delivered_at: null,
				dead_lettered_at: new Date(NOW.getTime() + DELIVERY_DEADLINE_MS),
				failure_reason: "delivery_expired",
			},
			{
				subscriber: "search",
				attempts: 0,
				delivered_at: null,
				dead_lettered_at: new Date(NOW.getTime() + DELIVERY_DEADLINE_MS),
				failure_reason: "delivery_expired",
			},
		]);
		expect(expiriesIn(justBefore.entries)).toEqual([]);
		expect(expiriesIn(onTheDay.entries)).toEqual([
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "error",
				message: "event deliveries expired",
				subscriber: "archive",
				reason: "delivery_expired",
				expired: 2,
			},
			{
				time: "2026-11-26T08:00:00.000Z",
				level: "error",
				message: "event deliveries expired",
				subscriber: "search",
				reason: "delivery_expired",
				expired: 2,
			},
		]);
	});

	test("is not attempted any more for an active plugin", async () => {
		const database = await migratedDatabase();
		const handled: string[] = [];
		const events = registryOf(
			subscription("search", async (event) => {
				handled.push(event.id);
			}),
		);
		await publishLabelRenamed(database.sql, events, EVENT);

		await deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
			now: () => new Date(NOW.getTime() + DELIVERY_DEADLINE_MS),
		}).delivery.deliverDue(NOT_STOPPED);

		expect(handled).toEqual([]);
		expect(await deliveriesOf(database.sql, EVENT)).toEqual([
			expect.objectContaining({
				delivered_at: null,
				failure_reason: "delivery_expired",
			}),
		]);
	});

	test("is dead-lettered a thousand in a run of the delivery, and the rest in the next run", async () => {
		const database = await migratedDatabase();
		await insertLabelRenamedOpenFor(
			database.sql,
			"archive",
			new Date(NOW.getTime() - DELIVERY_DEADLINE_MS),
			1_001,
		);
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events: searchSubscribing(),
		});

		await delivery.deliverDue(NOT_STOPPED);
		const expiredInTheFirstRun = expiriesIn(entries).map(
			({ expired }) => expired,
		);
		await delivery.deliverDue(NOT_STOPPED);

		expect(expiredInTheFirstRun).toEqual([1_000]);
		expect(expiriesIn(entries).map(({ expired }) => expired)).toEqual([
			1_000, 1,
		]);
	});
});

describe("an event whose deliveries were dead-lettered", () => {
	test("is removed from the outbox 7 days after its last delivery was dead-lettered, and not before", async () => {
		const database = await migratedDatabase();
		await publishLabelRenamed(
			database.sql,
			registryOf(subscription("archive", async () => {})),
			EVENT,
		);
		const at = (now: Date) =>
			deliveryOf({
				sql: database.sql,
				cancellation: database.cancellation,
				events: searchSubscribing(),
				now: () => now,
			});
		const deadLetteredAt = NOW.getTime() + DELIVERY_DEADLINE_MS;
		await at(new Date(deadLetteredAt)).delivery.deliverDue(NOT_STOPPED);

		await at(new Date(deadLetteredAt + 7 * DAY_MS - 1)).delivery.deliverDue(
			NOT_STOPPED,
		);
		const rowsJustBefore = await countRows(database.sql);
		await at(new Date(deadLetteredAt + 7 * DAY_MS)).delivery.deliverDue(
			NOT_STOPPED,
		);

		expect(rowsJustBefore).toEqual({ events: 1, deliveries: 1 });
		expect(await countRows(database.sql)).toEqual({ events: 0, deliveries: 0 });
	});
});

describe("settled events past their retention", () => {
	test("are removed a thousand in a run of the delivery, and the rest in the next run", async () => {
		const database = await migratedDatabase();
		await insertLabelRenamedDeliveredAt(
			database.sql,
			new Date(NOW.getTime() - 8 * DAY_MS),
			1_001,
		);
		const { delivery } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events: searchSubscribing(),
		});

		await delivery.deliverDue(NOT_STOPPED);
		const leftAfterTheFirstRun = await countRows(database.sql);
		await delivery.deliverDue(NOT_STOPPED);

		expect(leftAfterTheFirstRun).toEqual({ events: 1, deliveries: 1 });
		expect(await countRows(database.sql)).toEqual({ events: 0, deliveries: 0 });
	});

	test("are not looked for again by a process until an hour after it removed all there were", async () => {
		const database = await migratedDatabase();
		let now = NOW;
		const { delivery } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events: searchSubscribing(),
			now: () => now,
		});
		await delivery.deliverDue(NOT_STOPPED);
		await insertLabelRenamedDeliveredAt(
			database.sql,
			new Date(NOW.getTime() - 8 * DAY_MS),
			1,
		);

		now = new Date(NOW.getTime() + ONE_HOUR_MS - 1);
		await delivery.deliverDue(NOT_STOPPED);
		const leftWithinTheHour = await countRows(database.sql);
		now = new Date(NOW.getTime() + ONE_HOUR_MS);
		await delivery.deliverDue(NOT_STOPPED);

		expect(leftWithinTheHour).toEqual({ events: 1, deliveries: 1 });
		expect(await countRows(database.sql)).toEqual({ events: 0, deliveries: 0 });
	});

	test("include, once a process looks again, an older event that was still open while it removed the others", async () => {
		const database = await migratedDatabase();
		const search = searchSubscribing();
		await publishLabelRenamed(database.sql, search, EVENT);
		await insertLabelRenamedDeliveredAt(
			database.sql,
			new Date(NOW.getTime() + DAY_MS),
			1_001,
		);
		let now = new Date(NOW.getTime() + 9 * DAY_MS);
		const whileSearchIsNotActive = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events: registryOf(subscription("archive", async () => {})),
			now: () => now,
		}).delivery;
		await whileSearchIsNotActive.deliverDue(NOT_STOPPED);
		await whileSearchIsNotActive.deliverDue(NOT_STOPPED);
		const leftWhileOpen = await countRows(database.sql);
		await deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events: search,
			now: () => now,
		}).delivery.deliverDue(NOT_STOPPED);

		now = new Date(now.getTime() + 7 * DAY_MS);
		await whileSearchIsNotActive.deliverDue(NOT_STOPPED);

		expect(leftWhileOpen).toEqual({ events: 1, deliveries: 1 });
		expect(await countRows(database.sql)).toEqual({ events: 0, deliveries: 0 });
	});

	test("are left to the process that is already removing them, without waiting for it", async () => {
		const database = await migratedDatabase();
		await insertLabelRenamedDeliveredAt(
			database.sql,
			new Date(NOW.getTime() - 8 * DAY_MS),
			2,
		);
		const other = new SQL(database.url, { max: 1 });
		cleanups.push(() => other.close());
		const locked = deferred();
		const release = deferred();
		const otherProcess = other.begin(async (transaction) => {
			await transaction`
				SELECT FROM core.events
				WHERE sequence = (SELECT min(sequence) FROM core.events)
				FOR UPDATE`;
			locked.resolve();
			await release.promise;
		});
		await locked.promise;

		await deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events: searchSubscribing(),
		}).delivery.deliverDue(NOT_STOPPED);
		const leftWhileLocked = await countRows(database.sql);
		release.resolve();
		await otherProcess;

		expect(leftWhileLocked).toEqual({ events: 1, deliveries: 1 });
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
		const { delivery } = deliveryOf({
			sql: database.sql,
			cancellation: database.cancellation,
			events,
		});
		const loop = startPollLoop({
			run: (stopSignal) => delivery.deliverDue(stopSignal),
			failureMessage: "event delivery failed",
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
