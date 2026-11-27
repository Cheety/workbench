import {
	type EventDefinition,
	type EventHandlerContext,
	eventName,
	type PublishedEvent,
} from "@workbench/sdk";
import type { SQL, TransactionSQL } from "bun";
import { z } from "zod";
import { fullJitterBackoff } from "./database-wait.ts";
import type {
	EventRegistry,
	RegisteredSubscription,
} from "./event-registry.ts";
import { describeThrown, type ThrownError } from "./failure-reason.ts";
import { type HookTimeout, runWithin } from "./hook-timeout.ts";
import type { Logger } from "./logger.ts";
import { quote } from "./quote.ts";
import { pluginSchemaName } from "./schema-name.ts";
import type { ValidationIssue } from "./schema-validation.ts";
import { storedPayloadOf } from "./stored-payload.ts";

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
	readonly events: EventRegistry;
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
	return {
		deliverDue: async (stopSignal) => {
			if (options.events.subscriptions().length === 0) return;
			let position: Position | undefined = BEFORE_ALL;
			while (position !== undefined && !stopSignal.aborted)
				position = await attemptNext(position, attemptOptions);
		},
	};
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
	| { readonly outcome: "settled_elsewhere" };

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
				AND d.next_attempt_at <= ${now}
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
	const retryOf = (): Retry => {
		const inMs = options.retryDelayMs(due.attempts);
		return { at: new Date(now.getTime() + inMs), inMs };
	};
	try {
		return await options.sql.begin(async (transaction): Promise<Attempt> => {
			const details = await claim(transaction, due);
			if (details === undefined) return { outcome: "settled_elsewhere" };
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
			return postpone(transaction, due, failure, retryOf());
		});
	} catch (error) {
		return postpone(
			options.sql,
			due,
			{ reason: "delivery_failed", error: describeThrown(error) },
			retryOf(),
		);
	}
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
			AND attempts = ${delivery.attempts}
		RETURNING event_id`;
	return postponed.length === 0
		? { outcome: "settled_elsewhere" }
		: { outcome: "postponed", failure, retry };
}

function report(
	delivery: DueDelivery,
	attempt: Attempt,
	{ logger }: Pick<EventDeliveryOptions, "logger">,
): void {
	const deliveryLogger = logger.with({
		eventId: delivery.id,
		event: delivery.name,
		subscriber: delivery.subscriber,
	});
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
	try {
		await transaction.savepoint(async (savepoint) => {
			await savepoint.unsafe(`SET LOCAL search_path TO "${schema}"`);
			const outcome = await runWithin(
				() =>
					validateAndCallHandler(
						subscription,
						event,
						contextOf(savepoint, options),
					),
				options.handlerTimeout,
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
	ctx: EventHandlerContext,
): Promise<void> {
	const payload = await subscription.validatePayload(event.payload);
	if (!payload.valid)
		throw new HandlerFailedError({
			reason: "invalid_payload",
			issues: payload.issues,
		});
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
	transaction: SQL,
	sources: Pick<EventDeliveryOptions, "now" | "newId" | "random">,
): EventHandlerContext {
	return {
		sql: transaction,
		now: sources.now,
		newId: sources.newId,
		random: sources.random,
	};
}
