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
	const payload = await event.validatePayload(publication.payload);
	if (!payload.valid) throw new InvalidEventPayloadError(name, payload.issues);
	const subscribers = events
		.subscriptions()
		.filter((subscription) => subscription.event === name)
		.map((subscription) => subscription.subscriber);
	await transaction`
		INSERT INTO core.events (id, name, version, occurred_at, workspace_id, payload)
		VALUES (${publication.id}, ${name}, ${event.version}, ${publication.occurredAt}, ${publication.workspace}, ${payload.value})`;
	await transaction`
		INSERT INTO core.event_deliveries (event_id, subscriber, next_attempt_at)
		SELECT ${publication.id}, subscriber, ${publication.occurredAt}
		FROM unnest(${transaction.array(subscribers, "TEXT")}::text[]) AS subscriber`;
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

const claimedDelivery = z.object({
	id: z.string(),
	sequence: z.string(),
	name: z.string(),
	subscriber: z.string(),
	attempts: z.number(),
});

type ClaimedDelivery = z.infer<typeof claimedDelivery>;

const eventDetails = z.object({
	version: z.number(),
	occurred_at: z.date(),
	workspace_id: z.string(),
	payload: z.unknown(),
});

type DueDelivery = ClaimedDelivery & z.infer<typeof eventDetails>;

type Position = Pick<ClaimedDelivery, "sequence" | "subscriber">;

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

class UnknownSubscriptionError extends Error {
	constructor(delivery: ClaimedDelivery) {
		super(
			`no active plugin named ${quote(delivery.subscriber)} subscribes to the event ${quote(delivery.name)}`,
		);
		this.name = "UnknownSubscriptionError";
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
			const subscriptions = options.events.subscriptions();
			if (subscriptions.length === 0) return;
			let position: Position | undefined = BEFORE_ALL;
			while (position !== undefined && !stopSignal.aborted)
				position = await attemptNext(subscriptions, position, attemptOptions);
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

async function attemptNext(
	subscriptions: readonly RegisteredSubscription[],
	after: Position,
	options: AttemptOptions,
): Promise<Position | undefined> {
	const now = options.now();
	const claim: { delivery: ClaimedDelivery | undefined } = {
		delivery: undefined,
	};
	const retryOf = (delivery: ClaimedDelivery): Retry => {
		const inMs = options.retryDelayMs(delivery.attempts);
		return { at: new Date(now.getTime() + inMs), inMs };
	};
	try {
		const settled = await options.sql.begin(async (transaction) => {
			const row = await claimNext(transaction, subscriptions, after, now);
			if (row === undefined) return undefined;
			const claimed = claimedDelivery.parse(row);
			claim.delivery = claimed;
			const failure = await handle(
				transaction,
				{ ...claimed, ...eventDetails.parse(row) },
				subscriptions,
				options,
			);
			if (failure === undefined) {
				await markDelivered(transaction, claimed, now);
				return { claimed, failed: undefined };
			}
			const retry = retryOf(claimed);
			await postpone(transaction, claimed, retry);
			return { claimed, failed: { failure, retry } };
		});
		if (settled === undefined) return undefined;
		if (settled.failed === undefined)
			loggerOf(settled.claimed, options).debug("event delivered");
		else
			reportFailure(
				settled.claimed,
				settled.failed.failure,
				settled.failed.retry,
				options,
			);
		return settled.claimed;
	} catch (error) {
		const claimed = claim.delivery;
		if (claimed === undefined) throw error;
		const retry = retryOf(claimed);
		await postpone(options.sql, claimed, retry);
		reportFailure(
			claimed,
			{ reason: "delivery_failed", error: describeThrown(error) },
			retry,
			options,
		);
		return claimed;
	}
}

async function claimNext(
	transaction: TransactionSQL,
	subscriptions: readonly RegisteredSubscription[],
	after: Position,
	now: Date,
): Promise<unknown> {
	const [row]: unknown[] = await transaction`
		SELECT e.id, e.sequence, e.name, e.version, e.occurred_at, e.workspace_id, e.payload, d.subscriber, d.attempts
		FROM core.event_deliveries d
		JOIN core.events e ON e.id = d.event_id
		WHERE d.delivered_at IS NULL
			AND d.next_attempt_at <= ${now}
			AND (d.subscriber, e.name) IN (
				SELECT * FROM unnest(
					${transaction.array(
						subscriptions.map(({ subscriber }) => subscriber),
						"TEXT",
					)}::text[],
					${transaction.array(
						subscriptions.map(({ event }) => event),
						"TEXT",
					)}::text[]
				)
			)
			AND (e.sequence, d.subscriber) > (${after.sequence}::bigint, ${after.subscriber})
		ORDER BY e.sequence, d.subscriber
		LIMIT 1
		FOR UPDATE OF d SKIP LOCKED`;
	return row;
}

async function markDelivered(
	transaction: SQL,
	delivery: ClaimedDelivery,
	now: Date,
): Promise<void> {
	await transaction`
		UPDATE core.event_deliveries SET delivered_at = ${now}
		WHERE event_id = ${delivery.id} AND subscriber = ${delivery.subscriber}`;
}

async function postpone(
	sql: SQL,
	delivery: ClaimedDelivery,
	retry: Retry,
): Promise<void> {
	await sql`
		UPDATE core.event_deliveries
		SET attempts = ${delivery.attempts + 1}, next_attempt_at = ${retry.at}
		WHERE event_id = ${delivery.id}
			AND subscriber = ${delivery.subscriber}
			AND delivered_at IS NULL
			AND attempts = ${delivery.attempts}`;
}

function loggerOf(
	delivery: ClaimedDelivery,
	{ logger }: Pick<EventDeliveryOptions, "logger">,
): Logger {
	return logger.with({
		eventId: delivery.id,
		event: delivery.name,
		subscriber: delivery.subscriber,
	});
}

function reportFailure(
	delivery: ClaimedDelivery,
	failure: DeliveryFailure,
	retry: Retry,
	options: Pick<EventDeliveryOptions, "logger">,
): void {
	loggerOf(delivery, options).error("event not delivered", {
		...failure,
		attempt: delivery.attempts + 1,
		retryInMs: retry.inMs,
	});
}

async function handle(
	transaction: TransactionSQL,
	due: DueDelivery,
	subscriptions: readonly RegisteredSubscription[],
	options: AttemptOptions,
): Promise<DeliveryFailure | undefined> {
	const subscription = subscriptions.find(
		({ subscriber, event }) =>
			subscriber === due.subscriber && event === due.name,
	);
	if (subscription === undefined) throw new UnknownSubscriptionError(due);
	const payload = await subscription.validatePayload(due.payload);
	if (!payload.valid)
		return { reason: "invalid_payload", issues: payload.issues };
	const schema = pluginSchemaName(subscription.subscriber);
	try {
		await transaction.savepoint(async (savepoint) => {
			await savepoint.unsafe(`SET LOCAL search_path TO "${schema}"`);
			const outcome = await runWithin(
				() =>
					callHandler(
						subscription,
						publishedEventOf(due, payload.value),
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
	payload: unknown,
): PublishedEvent<unknown> {
	return {
		id: due.id,
		name: due.name,
		version: due.version,
		occurredAt: due.occurred_at,
		workspace: due.workspace_id,
		payload,
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
