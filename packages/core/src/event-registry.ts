import {
	type EventHandlerContext,
	eventName,
	eventSubscriptionCapability,
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
};

export type EventsRead = {
	readonly value: readonly RegisteredEvent[];
	readonly problems: readonly string[];
};

export type SubscriptionsRead = {
	readonly value: readonly RegisteredSubscription[];
	readonly problems: readonly string[];
};

const EVENT_NAME = /^[A-Z][A-Za-z0-9]*$/;

const PUBLISHER_SEPARATOR = ".";

export function isEventSubscriptionCapability(capability: string): boolean {
	const event = subscribedEventOf(capability);
	if (event === undefined) return false;
	const [publisher, ...name] = event.split(PUBLISHER_SEPARATOR);
	return (
		isPluginName(publisher) && EVENT_NAME.test(name.join(PUBLISHER_SEPARATOR))
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
	const read = readDefinition(candidate);
	return read.valid
		? { valid: true, event: read.event }
		: invalid(
				read.problem ??
					`events[${position}].name must be a fact in the past tense in PascalCase, such as "WorkspaceRenamed"`,
			);
}

type DefinitionRead =
	| {
			readonly valid: true;
			readonly event: RegisteredEvent;
			readonly subscriptionCapability: string;
	  }
	| { readonly valid: false; readonly problem: string | undefined };

function readDefinition(candidate: Record<string, unknown>): DefinitionRead {
	const { plugin, name, version, payload } = candidate;
	if (
		!isPluginName(plugin) ||
		typeof name !== "string" ||
		!EVENT_NAME.test(name)
	)
		return { valid: false, problem: undefined };
	const fullName = eventName({ plugin, name });
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
		return {
			valid: false,
			problem: `event ${quote(fullName)} must have a version that is a positive integer`,
		};
	const validatePayload = validatorOf(payload);
	if (validatePayload === undefined)
		return {
			valid: false,
			problem: `event ${quote(fullName)} must declare its payload as a schema`,
		};
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
	const definition = isRecord(candidate.event)
		? readDefinition(candidate.event)
		: undefined;
	if (definition === undefined || !definition.valid)
		return invalid(
			definition?.problem ??
				`subscriptions[${position}].event must be an event definition from the contract of the publishing plugin`,
		);
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

export function registerEvents(
	participants: readonly EventParticipant[],
): EventRegistry {
	const byName = new Map(
		participants.flatMap(({ events }) =>
			events.map((event) => [event.name, event] as const),
		),
	);
	const subscriptions = participants.flatMap(
		(participant) => participant.subscriptions,
	);
	return {
		findEvent: (name) => byName.get(name),
		subscriptions: () => subscriptions,
	};
}
