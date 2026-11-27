import type { Schema, Sql } from "./operation.ts";

export type EventDefinition<Payload> = {
	readonly plugin: string;
	readonly name: string;
	readonly version: number;
	readonly payload: Schema<Payload>;
};

export function defineEvent<Payload>(
	definition: EventDefinition<Payload>,
): EventDefinition<Payload> {
	return definition;
}

export type PublishedEvent<Payload> = {
	readonly id: string;
	readonly name: string;
	readonly version: number;
	readonly occurredAt: Date;
	readonly workspace: string;
	readonly payload: Payload;
};

export type EventHandlerContext = {
	readonly sql: Sql;
	now(): Date;
	newId(): string;
	random(): number;
};

export type EventSubscription<Payload> = {
	readonly event: EventDefinition<Payload>;
	handle(
		event: PublishedEvent<Payload>,
		ctx: EventHandlerContext,
	): Promise<void>;
};

export function defineEventSubscription<Payload>(
	subscription: EventSubscription<Payload>,
): EventSubscription<Payload> {
	return subscription;
}

export type EventSubscriptionCapability = {
	readonly event: string;
};

const EVENT_SUBSCRIPTION_CAPABILITY_PREFIX = "event:";

export function eventName(
	event: Pick<EventDefinition<unknown>, "plugin" | "name">,
): string {
	return `${event.plugin}.${event.name}`;
}

export function eventSubscriptionCapability(
	event: Pick<EventDefinition<unknown>, "plugin" | "name">,
): string {
	return `${EVENT_SUBSCRIPTION_CAPABILITY_PREFIX}${eventName(event)}`;
}

export function subscribedEventOf(capability: string): string | undefined {
	return capability.startsWith(EVENT_SUBSCRIPTION_CAPABILITY_PREFIX)
		? capability.slice(EVENT_SUBSCRIPTION_CAPABILITY_PREFIX.length)
		: undefined;
}
