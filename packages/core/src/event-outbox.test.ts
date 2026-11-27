import { afterEach, describe, expect, test } from "bun:test";
import { defineEvent } from "@workbench/sdk";
import { SQL } from "bun";
import { z } from "zod";
import { Secret } from "./config.ts";
import { createEventDelivery, recordEvent } from "./event-outbox.ts";
import {
	type EventRegistry,
	type RegisteredEvent,
	type RegisteredSubscription,
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

const NEVER_EXPIRING: HookTimeout = { ms: 10_000, setTimer: () => () => {} };

const labelRenamed = defineEvent({
	plugin: "board",
	name: "LabelRenamed",
	version: 1,
	payload: z.object({ labelId: z.string() }),
});

const LABEL_RENAMED: RegisteredEvent = {
	name: "board.LabelRenamed",
	version: 1,
	validatePayload: async (value) => ({ valid: true, value }),
};

function subscription(
	subscriber: string,
	handle: RegisteredSubscription["handle"],
): RegisteredSubscription {
	return {
		subscriber,
		event: LABEL_RENAMED.name,
		validatePayload: LABEL_RENAMED.validatePayload,
		handle,
	};
}

function registryOf(
	...subscriptions: readonly RegisteredSubscription[]
): EventRegistry {
	return registerEvents([{ events: [LABEL_RENAMED], subscriptions }]);
}

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
	readonly handlerTimeout?: HookTimeout;
};

function deliveryOf(scenario: DeliveryScenario) {
	const { logger, entries } = recordingLogger();
	const delivery = createEventDelivery({
		sql: scenario.sql,
		events: scenario.events,
		now: scenario.now ?? (() => NOW),
		newId: () => "00000000-0000-4000-8000-000000000001",
		random: () => 0.5,
		handlerTimeout: scenario.handlerTimeout ?? NEVER_EXPIRING,
		logger,
	});
	return { delivery, entries };
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
		const delivering = delivery.deliverDue();
		await timerSet;
		timer.expire();
		await delivering;
		now = LATER;
		await delivery.deliverDue();
		await delivery.deliverDue();

		expect(attempts).toBe(2);
		expect(failuresIn(entries)).toEqual([
			expect.objectContaining({
				event: EVENT,
				name: "board.LabelRenamed",
				subscriber: "search",
				reason: "handler_timed_out",
				timeoutMs: 250,
				attempt: 1,
				retryInMs: 500,
			}),
		]);
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
		}).delivery.deliverDue();
		const handledWhileInactive = [...handled];
		await deliveryOf({
			sql: database.sql,
			events: withSearch,
		}).delivery.deliverDue();

		expect(handledWhileInactive).toEqual([]);
		expect(handled).toEqual([EVENT]);
	});

	test("asks Postgres for nothing while no plugin subscribes to an event, so it may run before the core schema exists", async () => {
		const database = await freshDatabase();
		const { delivery, entries } = deliveryOf({
			sql: database.sql,
			events: registerEvents([]),
		});

		await delivery.deliverDue();

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
		}).delivery.deliverDue();
		await entered.promise;
		await deliveryOf({ sql: second, events }).delivery.deliverDue();
		release.resolve();
		await first;

		expect(handled).toEqual([EVENT]);
	});
});
