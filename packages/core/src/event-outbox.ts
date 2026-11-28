import {
	type EventDefinition,
	type EventHandlerContext,
	eventName,
	type PublishedEvent,
	type Sql,
} from "@workbench/sdk";
import type { SQL, TransactionSQL } from "bun";
import { z } from "zod";
import { fullJitterBackoff } from "./database-wait.ts";
import type {
	EventRegistry,
	RegisteredSubscription,
} from "./event-registry.ts";
import { describeThrown, type ThrownError } from "./failure-reason.ts";
import type { HookTimeout } from "./hook-timeout.ts";
import type { Logger } from "./logger.ts";
import { quote } from "./quote.ts";
import { pluginSchemaName } from "./schema-name.ts";
import type { ValidationIssue } from "./schema-validation.ts";
import { storedPayloadOf } from "./stored-payload.ts";
import { runInTransactionWithin } from "./transaction-deadline.ts";

export class UndeclaredEventError extends Error {
	constructor(publisher: string, event: string) {
		super(
			`${quote(publisher)} published the event ${quote(event)}, which it does not declare among its events`,
		);
		this.name = "UndeclaredEventError";
	}
}

export class InvalidEventPayloadError extends Error {
	readonly issues: readonly ValidationIssue[];

	constructor(event: string, issues: readonly ValidationIssue[]) {
		super(
			`the payload of the event ${quote(event)} does not match its payload schema`,
		);
		this.name = "InvalidEventPayloadError";
		this.issues = issues;
	}
}

export type EventPublication = {
	readonly id: string;
	readonly publisher: string;
	readonly definition: EventDefinition<unknown>;
	readonly payload: unknown;
	readonly occurredAt: Date;
	readonly workspace: string;
};

export async function recordEvent(
	transaction: SQL,
	events: EventRegistry,
	publication: EventPublication,
): Promise<void> {
	const name = eventName(publication.definition);
	const event = events.findEvent(name);
	if (
		event === undefined ||
		publication.definition.plugin !== publication.publisher
	)
		throw new UndeclaredEventError(publication.publisher, name);
	const payload = await storedPayloadOf(
		publication.payload,
		event.validatePayload,
	);
	if (!payload.valid) throw new InvalidEventPayloadError(name, payload.issues);
	await transaction`
		INSERT INTO core.events (id, name, version, occurred_at, workspace_id, payload)
		VALUES (${publication.id}, ${name}, ${event.version}, ${publication.occurredAt}, ${publication.workspace}, ${payload.json}::text::jsonb)`;
	await transaction`
		INSERT INTO core.event_deliveries (event_id, event_sequence, subscriber, next_attempt_at)
		SELECT e.id, e.sequence, subscriber, ${publication.occurredAt}
		FROM core.events e
		CROSS JOIN unnest(${transaction.array([...events.subscribersOf(name)], "TEXT")}::text[]) AS subscriber
		WHERE e.id = ${publication.id}`;
}

export type EventDeliveryOptions = {
	readonly sql: SQL;
	readonly cancellation: SQL;
	readonly events: EventRegistry;
	readonly hasCoreSchema: () => boolean;
	readonly now: () => Date;
	readonly newId: () => string;
	readonly random: () => number;
	readonly handlerTimeout: HookTimeout;
	readonly logger: Logger;
};

export type EventDelivery = {
	deliverDue(stopSignal: AbortSignal): Promise<void>;
};

const RETRY = { baseMs: 1_000, capMs: 300_000 } as const;

const MOST_ATTEMPTS = 25;

const DAY_MS = 86_400_000;

const DELIVERY_DEADLINE_MS = 30 * DAY_MS;

const RETENTION_MS = 7 * DAY_MS;

const MOST_SETTLED_PER_RUN = 1_000;

const REMOVAL_INTERVAL_MS = 3_600_000;

const dueDelivery = z.object({
	id: z.string(),
	sequence: z.string(),
	name: z.string(),
	subscriber: z.string(),
	attempts: z.number(),
});

type DueDelivery = z.infer<typeof dueDelivery>;

const eventDetails = z.object({
	version: z.number(),
	occurred_at: z.date(),
	workspace_id: z.string(),
	payload: z.unknown(),
});

type EventDetails = z.infer<typeof eventDetails>;

type Position = Pick<DueDelivery, "sequence" | "subscriber">;

const BEFORE_ALL: Position = { sequence: "0", subscriber: "" };

type DeliveryFailure =
	| { readonly reason: "handler_threw"; readonly error: ThrownError }
	| { readonly reason: "handler_timed_out"; readonly timeoutMs: number }
	| {
			readonly reason: "invalid_payload";
			readonly issues: readonly ValidationIssue[];
	  }
	| { readonly reason: "delivery_failed"; readonly error: ThrownError };

const EXPIRED = "delivery_expired";

class HandlerFailedError extends Error {
	readonly failure: DeliveryFailure;

	constructor(failure: DeliveryFailure) {
		super(`the handler did not handle the event (${failure.reason})`);
		this.name = "HandlerFailedError";
		this.failure = failure;
	}
}

export function createEventDelivery(
	options: EventDeliveryOptions,
): EventDelivery {
	const attemptOptions: AttemptOptions = {
		...options,
		retryDelayMs: fullJitterBackoff({ ...RETRY, random: options.random }),
	};
	const keepRetention = retentionKeeperOf(options);
	return {
		deliverDue: async (stopSignal) => {
			if (!options.hasCoreSchema()) return;
			let position: Position | undefined =
				options.events.subscriptions().length === 0 ? undefined : BEFORE_ALL;
			while (position !== undefined && !stopSignal.aborted)
				position = await attemptNext(position, attemptOptions);
			if (position === undefined) await keepRetention(options.now());
		},
	};
}

function retentionKeeperOf({
	sql,
	logger,
}: Pick<EventDeliveryOptions, "sql" | "logger">): (now: Date) => Promise<void> {
	let restsUntil = Number.NEGATIVE_INFINITY;
	let expiresFrom: Date | null = null;
	let removesFrom: Date | null = null;
	return async (now) => {
		if (now.getTime() < restsUntil) return;
		const expired = await expireOverdue(
			{ sql, logger },
			{ occurredFrom: expiresFrom, now },
		);
		const { removed, latest_occurred_at } = await removeSettled(sql, {
			occurredFrom: removesFrom,
			settledBy: new Date(now.getTime() - RETENTION_MS),
		});
		const mayLeaveMoreOverdue = expired.count === MOST_SETTLED_PER_RUN;
		const mayLeaveMoreRemovable = removed === MOST_SETTLED_PER_RUN;
		expiresFrom = mayLeaveMoreOverdue ? expired.latestOccurredAt : null;
		removesFrom = mayLeaveMoreRemovable ? latest_occurred_at : null;
		if (!mayLeaveMoreOverdue && !mayLeaveMoreRemovable)
			restsUntil = now.getTime() + REMOVAL_INTERVAL_MS;
		if (removed > 0) logger.debug("settled events removed", { removed });
	};
}

const expiry = z.object({
	subscriber: z.string(),
	expired: z.number(),
	latest_occurred_at: z.date(),
});

type OverdueDeliveries = {
	readonly occurredFrom: Date | null;
	readonly now: Date;
};

type Expiry = {
	readonly count: number;
	readonly latestOccurredAt: Date | null;
};

async function expireOverdue(
	{ sql, logger }: Pick<EventDeliveryOptions, "sql" | "logger">,
	{ occurredFrom, now }: OverdueDeliveries,
): Promise<Expiry> {
	const rows: unknown[] = await sql`
		WITH overdue AS (
			SELECT d.event_id, d.subscriber, e.occurred_at
			FROM core.events e
			JOIN core.event_deliveries d ON d.event_id = e.id
			WHERE e.occurred_at >= coalesce(${occurredFrom}::timestamptz, '-infinity')
				AND e.occurred_at <= ${deadlinePassedBy(now)}
				AND d.delivered_at IS NULL
				AND d.dead_lettered_at IS NULL
			ORDER BY e.occurred_at
			LIMIT ${MOST_SETTLED_PER_RUN}
			FOR UPDATE OF d SKIP LOCKED
		),
		expired AS (
			UPDATE core.event_deliveries d
			SET dead_lettered_at = ${now}, failure_reason = ${EXPIRED}
			FROM overdue
			WHERE d.event_id = overdue.event_id AND d.subscriber = overdue.subscriber
			RETURNING d.subscriber, overdue.occurred_at
		)
		SELECT subscriber, count(*)::integer AS expired, max(occurred_at) AS latest_occurred_at
		FROM expired
		GROUP BY subscriber
		ORDER BY subscriber`;
	let count = 0;
	let latestOccurredAt: Date | null = null;
	for (const row of rows.map((row) => expiry.parse(row))) {
		logger.error("event deliveries expired", {
			subscriber: row.subscriber,
			reason: EXPIRED,
			expired: row.expired,
		});
		count += row.expired;
		if (latestOccurredAt === null || row.latest_occurred_at > latestOccurredAt)
			latestOccurredAt = row.latest_occurred_at;
	}
	return { count, latestOccurredAt };
}

function deadlinePassedBy(now: Date): Date {
	return new Date(now.getTime() - DELIVERY_DEADLINE_MS);
}

type ExpiredEvents = {
	readonly occurredFrom: Date | null;
	readonly settledBy: Date;
};

const removal = z.object({
	removed: z.number(),
	latest_occurred_at: z.date().nullable(),
});

type Removal = z.infer<typeof removal>;

async function removeSettled(
	sql: SQL,
	{ occurredFrom, settledBy }: ExpiredEvents,
): Promise<Removal> {
	const [row]: unknown[] = await sql`
		WITH expired AS (
			SELECT e.id FROM core.events e
			WHERE e.occurred_at >= coalesce(${occurredFrom}::timestamptz, '-infinity')
				AND e.occurred_at <= ${settledBy}
				AND NOT EXISTS (
					SELECT FROM core.event_deliveries d
					WHERE d.event_id = e.id
						AND coalesce(d.delivered_at, d.dead_lettered_at, 'infinity') > ${settledBy}
				)
			ORDER BY e.occurred_at
			LIMIT ${MOST_SETTLED_PER_RUN}
			FOR UPDATE OF e SKIP LOCKED
		),
		removed_deliveries AS (
			DELETE FROM core.event_deliveries
			WHERE event_id IN (SELECT id FROM expired)
		),
		removed_events AS (
			DELETE FROM core.events
			WHERE id IN (SELECT id FROM expired)
			RETURNING occurred_at
		)
		SELECT count(*)::integer AS removed, max(occurred_at) AS latest_occurred_at
		FROM removed_events`;
	return removal.parse(row);
}

type AttemptOptions = EventDeliveryOptions & {
	readonly retryDelayMs: (attempt: number) => number;
};

type Retry = {
	readonly at: Date;
	readonly inMs: number;
};

type Attempt =
	| { readonly outcome: "delivered" }
	| {
			readonly outcome: "postponed";
			readonly failure: DeliveryFailure;
			readonly retry: Retry;
	  }
	| { readonly outcome: "dead_lettered"; readonly failure: DeliveryFailure }
	| { readonly outcome: "settled_elsewhere" };

const SETTLED_ELSEWHERE: Attempt = { outcome: "settled_elsewhere" };

async function attemptNext(
	after: Position,
	options: AttemptOptions,
): Promise<Position | undefined> {
	const now = options.now();
	const due = await findNextDue(options, after, now);
	if (due === undefined) return undefined;
	const subscription = options.events.findSubscription(
		due.subscriber,
		due.name,
	);
	if (subscription === undefined) return due;
	report(due, await attempt(due, subscription, now, options), options);
	return due;
}

async function findNextDue(
	{ sql, events }: Pick<EventDeliveryOptions, "sql" | "events">,
	after: Position,
	now: Date,
): Promise<DueDelivery | undefined> {
	const subscriptions = events.subscriptions();
	const [row]: unknown[] = await sql`
		WITH subscription (subscriber, event) AS (
			SELECT * FROM unnest(
				${sql.array(
					subscriptions.map(({ subscriber }) => subscriber),
					"TEXT",
				)}::text[],
				${sql.array(
					subscriptions.map(({ event }) => event),
					"TEXT",
				)}::text[]
			)
		)
		SELECT due.id, due.sequence, due.name, due.subscriber, due.attempts
		FROM (SELECT DISTINCT subscriber FROM subscription) active
		CROSS JOIN LATERAL (
			SELECT e.id, d.event_sequence AS sequence, e.name, d.subscriber, d.attempts
			FROM core.event_deliveries d
			JOIN core.events e ON e.id = d.event_id
			WHERE d.subscriber = active.subscriber
				AND d.delivered_at IS NULL
				AND d.dead_lettered_at IS NULL
				AND d.next_attempt_at <= ${now}
				AND e.occurred_at > ${deadlinePassedBy(now)}
				AND d.event_sequence >= ${after.sequence}::bigint
				AND (d.event_sequence, d.subscriber) > (${after.sequence}::bigint, ${after.subscriber})
				AND EXISTS (
					SELECT FROM subscription s
					WHERE s.subscriber = d.subscriber AND s.event = e.name
				)
			ORDER BY d.event_sequence
			LIMIT 1
		) due
		ORDER BY due.sequence, due.subscriber
		LIMIT 1`;
	return row === undefined ? undefined : dueDelivery.parse(row);
}

async function attempt(
	due: DueDelivery,
	subscription: RegisteredSubscription,
	now: Date,
	options: AttemptOptions,
): Promise<Attempt> {
	const failed = { delivery: due, now, retryDelayMs: options.retryDelayMs };
	try {
		return await options.sql.begin(async (transaction): Promise<Attempt> => {
			const details = await claim(transaction, due);
			if (details === undefined) return SETTLED_ELSEWHERE;
			const failure = await handle(
				transaction,
				subscription,
				publishedEventOf(due, details),
				options,
			);
			if (failure === undefined) {
				await markDelivered(transaction, due, now);
				return { outcome: "delivered" };
			}
			return settleFailed(transaction, failed, failure);
		});
	} catch (error) {
		return settleFailed(options.sql, failed, {
			reason: "delivery_failed",
			error: describeThrown(error),
		});
	}
}

type FailedAttempt = {
	readonly delivery: DueDelivery;
	readonly now: Date;
	readonly retryDelayMs: (attempt: number) => number;
};

function settleFailed(
	sql: SQL,
	{ delivery, now, retryDelayMs }: FailedAttempt,
	failure: DeliveryFailure,
): Promise<Attempt> {
	if (delivery.attempts + 1 >= MOST_ATTEMPTS)
		return deadLetter(sql, delivery, failure, now);
	const inMs = retryDelayMs(delivery.attempts);
	return postpone(sql, delivery, failure, {
		at: new Date(now.getTime() + inMs),
		inMs,
	});
}

async function claim(
	transaction: TransactionSQL,
	due: DueDelivery,
): Promise<EventDetails | undefined> {
	const [row]: unknown[] = await transaction`
		SELECT e.version, e.occurred_at, e.workspace_id, e.payload
		FROM core.event_deliveries d
		JOIN core.events e ON e.id = d.event_id
		WHERE d.event_id = ${due.id}
			AND d.subscriber = ${due.subscriber}
			AND d.delivered_at IS NULL
			AND d.dead_lettered_at IS NULL
			AND d.attempts = ${due.attempts}
		FOR UPDATE OF d SKIP LOCKED`;
	return row === undefined ? undefined : eventDetails.parse(row);
}

async function markDelivered(
	transaction: SQL,
	delivery: DueDelivery,
	now: Date,
): Promise<void> {
	await transaction`
		UPDATE core.event_deliveries SET delivered_at = ${now}
		WHERE event_id = ${delivery.id} AND subscriber = ${delivery.subscriber}`;
}

async function postpone(
	sql: SQL,
	delivery: DueDelivery,
	failure: DeliveryFailure,
	retry: Retry,
): Promise<Attempt> {
	const postponed: unknown[] = await sql`
		UPDATE core.event_deliveries
		SET attempts = ${delivery.attempts + 1}, next_attempt_at = ${retry.at}
		WHERE event_id = ${delivery.id}
			AND subscriber = ${delivery.subscriber}
			AND delivered_at IS NULL
			AND dead_lettered_at IS NULL
			AND attempts = ${delivery.attempts}
		RETURNING event_id`;
	return postponed.length === 0
		? SETTLED_ELSEWHERE
		: { outcome: "postponed", failure, retry };
}

async function deadLetter(
	sql: SQL,
	delivery: DueDelivery,
	failure: DeliveryFailure,
	now: Date,
): Promise<Attempt> {
	const deadLettered: unknown[] = await sql`
		UPDATE core.event_deliveries
		SET attempts = ${delivery.attempts + 1},
			dead_lettered_at = ${now},
			failure_reason = ${failure.reason}
		WHERE event_id = ${delivery.id}
			AND subscriber = ${delivery.subscriber}
			AND delivered_at IS NULL
			AND dead_lettered_at IS NULL
			AND attempts = ${delivery.attempts}
		RETURNING event_id`;
	return deadLettered.length === 0
		? SETTLED_ELSEWHERE
		: { outcome: "dead_lettered", failure };
}

function loggerOf(
	delivery: Pick<DueDelivery, "id" | "name" | "subscriber">,
	{ logger }: Pick<EventDeliveryOptions, "logger">,
): Logger {
	return logger.with({
		eventId: delivery.id,
		event: delivery.name,
		subscriber: delivery.subscriber,
	});
}

function report(
	delivery: DueDelivery,
	attempt: Attempt,
	options: Pick<EventDeliveryOptions, "logger">,
): void {
	const deliveryLogger = loggerOf(delivery, options);
	switch (attempt.outcome) {
		case "delivered":
			deliveryLogger.debug("event delivered");
			return;
		case "postponed":
			deliveryLogger.error("event not delivered", {
				...attempt.failure,
				attempt: delivery.attempts + 1,
				retryInMs: attempt.retry.inMs,
			});
			return;
		case "dead_lettered":
			deliveryLogger.error("event dead-lettered", {
				...attempt.failure,
				attempt: delivery.attempts + 1,
			});
			return;
		case "settled_elsewhere":
			return;
	}
}

async function handle(
	transaction: TransactionSQL,
	subscription: RegisteredSubscription,
	event: PublishedEvent<unknown>,
	options: AttemptOptions,
): Promise<DeliveryFailure | undefined> {
	const schema = pluginSchemaName(subscription.subscriber);
	const logger = loggerOf(
		{ id: event.id, name: event.name, subscriber: subscription.subscriber },
		options,
	);
	try {
		await transaction.savepoint(async (savepoint) => {
			await savepoint.unsafe(`SET LOCAL search_path TO "${schema}"`);
			const outcome = await runInTransactionWithin(
				savepoint,
				({ sql, expired }) =>
					validateAndCallHandler(subscription, event, {
						ctx: contextOf(sql, options),
						expired,
					}),
				{
					timeout: options.handlerTimeout,
					cancellation: options.cancellation,
					logger,
				},
			);
			if (outcome === "timed_out")
				throw new HandlerFailedError({
					reason: "handler_timed_out",
					timeoutMs: options.handlerTimeout.ms,
				});
		});
		return undefined;
	} catch (error) {
		if (error instanceof HandlerFailedError) return error.failure;
		throw error;
	}
}

async function validateAndCallHandler(
	subscription: RegisteredSubscription,
	event: PublishedEvent<unknown>,
	{
		ctx,
		expired,
	}: { readonly ctx: EventHandlerContext; readonly expired: AbortSignal },
): Promise<void> {
	const payload = await subscription.validatePayload(event.payload);
	if (!payload.valid)
		throw new HandlerFailedError({
			reason: "invalid_payload",
			issues: payload.issues,
		});
	if (expired.aborted) return;
	await callHandler(subscription, { ...event, payload: payload.value }, ctx);
}

async function callHandler(
	subscription: RegisteredSubscription,
	event: PublishedEvent<unknown>,
	ctx: EventHandlerContext,
): Promise<void> {
	try {
		await subscription.handle(event, ctx);
	} catch (error) {
		throw new HandlerFailedError({
			reason: "handler_threw",
			error: describeThrown(error),
		});
	}
}

function publishedEventOf(
	due: DueDelivery,
	details: EventDetails,
): PublishedEvent<unknown> {
	return {
		id: due.id,
		name: due.name,
		version: details.version,
		occurredAt: details.occurred_at,
		workspace: details.workspace_id,
		payload: details.payload,
	};
}

function contextOf(
	sql: Sql,
	sources: Pick<EventDeliveryOptions, "now" | "newId" | "random">,
): EventHandlerContext {
	return {
		sql,
		now: sources.now,
		newId: sources.newId,
		random: sources.random,
	};
}
