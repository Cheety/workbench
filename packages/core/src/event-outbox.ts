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
	if (event === undefined || !name.startsWith(`${publication.publisher}.`))
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

const dueDelivery = z.object({
	id: z.string(),
	sequence: z.string(),
	name: z.string(),
	version: z.number(),
	occurred_at: z.date(),
	workspace_id: z.string(),
	payload: z.unknown(),
	subscriber: z.string(),
	attempts: z.number(),
});

type DueDelivery = z.infer<typeof dueDelivery>;

type Position = {
	readonly sequence: string;
	readonly subscriber: string;
};

const BEFORE_ALL: Position = { sequence: "0", subscriber: "" };

type DeliveryFailure =
	| { readonly reason: "handler_threw"; readonly error: ThrownError }
	| { readonly reason: "handler_timed_out"; readonly timeoutMs: number }
	| {
			readonly reason: "invalid_payload";
			readonly issues: readonly ValidationIssue[];
	  };

class DeliveryFailedError extends Error {
	readonly failure: DeliveryFailure;

	constructor(failure: DeliveryFailure) {
		super(`the event was not delivered (${failure.reason})`);
		this.name = "DeliveryFailedError";
		this.failure = failure;
	}
}

type Attempt = {
	readonly position: Position;
	readonly report: () => void;
};

export function createEventDelivery(
	options: EventDeliveryOptions,
): EventDelivery {
	const retryDelayMs = fullJitterBackoff({ ...RETRY, random: options.random });
	return {
		deliverDue: async (stopSignal) => {
			const subscriptions = options.events.subscriptions();
			if (subscriptions.length === 0) return;
			let position = BEFORE_ALL;
			while (!stopSignal.aborted) {
				const attempt = await options.sql.begin((transaction) =>
					attemptNext(transaction, subscriptions, position, {
						...options,
						retryDelayMs,
					}),
				);
				if (attempt === undefined) return;
				attempt.report();
				position = attempt.position;
			}
		},
	};
}

type AttemptOptions = EventDeliveryOptions & {
	readonly retryDelayMs: (attempt: number) => number;
};

async function attemptNext(
	transaction: TransactionSQL,
	subscriptions: readonly RegisteredSubscription[],
	after: Position,
	options: AttemptOptions,
): Promise<Attempt | undefined> {
	const now = options.now();
	const [row] = await transaction`
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
	if (row === undefined) return undefined;
	const due = dueDelivery.parse(row);
	const position = { sequence: due.sequence, subscriber: due.subscriber };
	const subscription = subscriptions.find(
		({ subscriber, event }) =>
			subscriber === due.subscriber && event === due.name,
	);
	if (subscription === undefined) return { position, report: () => {} };
	const logger = options.logger.with({
		event: due.id,
		name: due.name,
		subscriber: due.subscriber,
	});
	const failure = await handle(transaction, subscription, due, options);
	if (failure === undefined) {
		await transaction`
			UPDATE core.event_deliveries SET delivered_at = ${now}
			WHERE event_id = ${due.id} AND subscriber = ${due.subscriber}`;
		return { position, report: () => logger.debug("event delivered") };
	}
	const retryInMs = options.retryDelayMs(due.attempts);
	await transaction`
		UPDATE core.event_deliveries
		SET attempts = attempts + 1, next_attempt_at = ${new Date(now.getTime() + retryInMs)}
		WHERE event_id = ${due.id} AND subscriber = ${due.subscriber}`;
	return {
		position,
		report: () =>
			logger.error("event not delivered", {
				...failure,
				attempt: due.attempts + 1,
				retryInMs,
			}),
	};
}

async function handle(
	transaction: TransactionSQL,
	subscription: RegisteredSubscription,
	due: DueDelivery,
	options: AttemptOptions,
): Promise<DeliveryFailure | undefined> {
	const schema = pluginSchemaName(subscription.subscriber);
	try {
		await transaction.savepoint(async (savepoint) => {
			await savepoint.unsafe(`SET LOCAL search_path TO "${schema}"`);
			const payload = await subscription.validatePayload(due.payload);
			if (!payload.valid)
				throw new DeliveryFailedError({
					reason: "invalid_payload",
					issues: payload.issues,
				});
			const outcome = await runWithin(
				() =>
					subscription.handle(
						publishedEventOf(due, payload.value),
						contextOf(savepoint, options),
					),
				options.handlerTimeout,
			);
			if (outcome === "timed_out")
				throw new DeliveryFailedError({
					reason: "handler_timed_out",
					timeoutMs: options.handlerTimeout.ms,
				});
		});
		return undefined;
	} catch (error) {
		return error instanceof DeliveryFailedError
			? error.failure
			: { reason: "handler_threw", error: describeThrown(error) };
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
