import {
	type EventHandlerContext,
	eventName,
	eventNameParts,
	eventSubscriptionCapability,
	isEventDefinitionName,
	type PublishedEvent,
	subscribedEventOf,
} from "@workbench/sdk";
import { isRecord } from "./is-record.ts";
import { isPluginName } from "./plugin-name.ts";
import { quote } from "./quote.ts";
import { type Validator, validatorOf } from "./schema-validation.ts";

export type RegisteredEvent = {
	readonly name: string;
	readonly version: number;
	readonly validatePayload: Validator;
};

export type RegisteredSubscription = {
	readonly subscriber: string;
	readonly event: string;
	readonly validatePayload: Validator;
	handle(
		event: PublishedEvent<unknown>,
		ctx: EventHandlerContext,
	): Promise<void>;
};

export type EventRegistry = {
	findEvent(name: string): RegisteredEvent | undefined;
	subscriptions(): readonly RegisteredSubscription[];
	subscribersOf(event: string): readonly string[];
	findSubscription(
		subscriber: string,
		event: string,
	): RegisteredSubscription | undefined;
};

export type EventsRead = {
	readonly value: readonly RegisteredEvent[];
	readonly problems: readonly string[];
};

export type SubscriptionsRead = {
	readonly value: readonly RegisteredSubscription[];
	readonly problems: readonly string[];
};

export function isEventSubscriptionCapability(capability: string): boolean {
	const event = subscribedEventOf(capability);
	const parts = event === undefined ? undefined : eventNameParts(event);
	return (
		parts !== undefined &&
		isPluginName(parts.plugin) &&
		isEventDefinitionName(parts.name)
	);
}

export function readEvents(plugin: string, declared: unknown): EventsRead {
	if (declared === undefined) return { value: [], problems: [] };
	if (!Array.isArray(declared))
		return {
			value: [],
			problems: ["events must be a list of event definitions"],
		};
	const value: RegisteredEvent[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const [position, candidate] of declared.entries()) {
		const read = readEvent(plugin, position, candidate);
		if (!read.valid) {
			problems.push(read.problem);
			continue;
		}
		if (seen.has(read.event.name)) {
			problems.push(
				`event ${quote(read.event.name)} is declared more than once`,
			);
			continue;
		}
		seen.add(read.event.name);
		value.push(read.event);
	}
	return { value, problems };
}

type EventRead =
	| { readonly valid: true; readonly event: RegisteredEvent }
	| { readonly valid: false; readonly problem: string };

function readEvent(
	plugin: string,
	position: number,
	candidate: unknown,
): EventRead {
	if (!isRecord(candidate))
		return invalid(`events[${position}] must be an event definition`);
	if (candidate.plugin !== plugin)
		return invalid(
			`events[${position}] must name ${quote(plugin)} as its plugin, the plugin that publishes it`,
		);
	const read = readDefinition(candidate, `events[${position}]`);
	return read.valid ? { valid: true, event: read.event } : read;
}

type DefinitionRead =
	| {
			readonly valid: true;
			readonly event: RegisteredEvent;
			readonly subscriptionCapability: string;
	  }
	| { readonly valid: false; readonly problem: string };

function readDefinition(
	candidate: Record<string, unknown>,
	subject: string,
): DefinitionRead {
	const { plugin, name, version, payload } = candidate;
	if (!isPluginName(plugin))
		return invalid(
			`${subject}.plugin must be the name of the publishing plugin`,
		);
	if (!isEventDefinitionName(name))
		return invalid(
			`${subject}.name must be in PascalCase, such as "WorkspaceRenamed"`,
		);
	const fullName = eventName({ plugin, name });
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
		return invalid(
			`event ${quote(fullName)} must have a version that is a positive integer`,
		);
	const validatePayload = validatorOf(payload);
	if (validatePayload === undefined)
		return invalid(
			`event ${quote(fullName)} must declare its payload as a schema`,
		);
	return {
		valid: true,
		event: { name: fullName, version, validatePayload },
		subscriptionCapability: eventSubscriptionCapability({ plugin, name }),
	};
}

function invalid(problem: string): { valid: false; problem: string } {
	return { valid: false, problem };
}

export function readSubscriptions(
	subscriber: string,
	declared: unknown,
	capabilities: readonly string[],
): SubscriptionsRead {
	if (declared === undefined) return { value: [], problems: [] };
	if (!Array.isArray(declared))
		return {
			value: [],
			problems: ["subscriptions must be a list of event subscriptions"],
		};
	const value: RegisteredSubscription[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const [position, candidate] of declared.entries()) {
		const read = readSubscription(subscriber, position, candidate);
		if (!read.valid) {
			problems.push(read.problem);
			continue;
		}
		const { event } = read.subscription;
		if (seen.has(event)) {
			problems.push(`event ${quote(event)} is subscribed to more than once`);
			continue;
		}
		seen.add(event);
		if (!capabilities.includes(read.capability)) {
			problems.push(
				`the subscription to event ${quote(event)} requires the capability ${quote(read.capability)} in manifest.capabilities`,
			);
			continue;
		}
		value.push(read.subscription);
	}
	return { value, problems };
}

type SubscriptionRead =
	| {
			readonly valid: true;
			readonly subscription: RegisteredSubscription;
			readonly capability: string;
	  }
	| { readonly valid: false; readonly problem: string };

function readSubscription(
	subscriber: string,
	position: number,
	candidate: unknown,
): SubscriptionRead {
	if (!isRecord(candidate))
		return invalid(`subscriptions[${position}] must be an event subscription`);
	if (!isRecord(candidate.event))
		return invalid(
			`subscriptions[${position}].event must be an event definition from the contract of the publishing plugin`,
		);
	const definition = readDefinition(
		candidate.event,
		`subscriptions[${position}].event`,
	);
	if (!definition.valid) return definition;
	const { event } = definition;
	const { handle } = candidate;
	if (typeof handle !== "function")
		return invalid(
			`the subscription to event ${quote(event.name)} must have a handle function`,
		);
	return {
		valid: true,
		capability: definition.subscriptionCapability,
		subscription: {
			subscriber,
			event: event.name,
			validatePayload: event.validatePayload,
			handle: async (published, ctx) => {
				await handle.call(candidate, published, ctx);
			},
		},
	};
}

export type EventParticipant = {
	readonly events: readonly RegisteredEvent[];
	readonly subscriptions: readonly RegisteredSubscription[];
};

export type EventParticipants = {
	readonly active: readonly EventParticipant[];
	readonly notActive: readonly EventParticipant[];
};

export function registerEvents({
	active,
	notActive,
}: EventParticipants): EventRegistry {
	const byName = new Map(
		active.flatMap(({ events }) =>
			events.map((event) => [event.name, event] as const),
		),
	);
	const subscriptions = active.flatMap(
		(participant) => participant.subscriptions,
	);
	const declared = [
		...subscriptions,
		...notActive.flatMap((participant) => participant.subscriptions),
	];
	return {
		findEvent: (name) => byName.get(name),
		subscriptions: () => subscriptions,
		subscribersOf: (event) =>
			declared
				.filter((subscription) => subscription.event === event)
				.map((subscription) => subscription.subscriber),
		findSubscription: (subscriber, event) =>
			subscriptions.find(
				(subscription) =>
					subscription.subscriber === subscriber &&
					subscription.event === event,
			),
	};
}
