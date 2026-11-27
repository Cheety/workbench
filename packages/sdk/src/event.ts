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

type EventNameParts = Pick<EventDefinition<unknown>, "plugin" | "name">;

const EVENT_NAME_SEPARATOR = ".";

const EVENT_DEFINITION_NAME = /^[A-Z][A-Za-z0-9]*$/;

export function isEventDefinitionName(name: unknown): name is string {
	return typeof name === "string" && EVENT_DEFINITION_NAME.test(name);
}

export function eventName(event: EventNameParts): string {
	return `${event.plugin}${EVENT_NAME_SEPARATOR}${event.name}`;
}

export function eventNameParts(name: string): EventNameParts | undefined {
	const separator = name.indexOf(EVENT_NAME_SEPARATOR);
	return separator === -1
		? undefined
		: {
				plugin: name.slice(0, separator),
				name: name.slice(separator + EVENT_NAME_SEPARATOR.length),
			};
}

export function eventSubscriptionCapability(event: EventNameParts): string {
	return `${EVENT_SUBSCRIPTION_CAPABILITY_PREFIX}${eventName(event)}`;
}

export function subscribedEventOf(capability: string): string | undefined {
	return capability.startsWith(EVENT_SUBSCRIPTION_CAPABILITY_PREFIX)
		? capability.slice(EVENT_SUBSCRIPTION_CAPABILITY_PREFIX.length)
		: undefined;
}
