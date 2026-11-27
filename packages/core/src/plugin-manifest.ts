import { DATABASE_CAPABILITY, type PluginContext } from "@workbench/sdk";
import {
	isEventSubscriptionCapability,
	type RegisteredEvent,
	type RegisteredSubscription,
	readEvents,
	readSubscriptions,
} from "./event-registry.ts";
import { isRecord } from "./is-record.ts";
import { type RegisteredJob, readJobs } from "./job-registry.ts";
import {
	CORE_OWNER_NAME,
	type RegisteredOperation,
	readOperations,
} from "./operation-registry.ts";
import { isPluginName } from "./plugin-name.ts";
import { quote } from "./quote.ts";
import type { Migration } from "./schema-migrations.ts";
import { MAX_PLUGIN_NAME_LENGTH } from "./schema-name.ts";

const SEMVER_VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const VERSION_PART = String.raw`(?:0|[1-9]\d*|[xX*])`;
const PARTIAL_VERSION = String.raw`${VERSION_PART}(?:\.${VERSION_PART}(?:\.${VERSION_PART}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)?`;
const COMPARATOR = String.raw`(?:(?:\^|~|>=|<=|>|<|=)\s*)?${PARTIAL_VERSION}`;
const COMPARATOR_SET = String.raw`${COMPARATOR}(?:\s+${COMPARATOR})*`;
const SEMVER_RANGE = new RegExp(
	String.raw`^\s*${COMPARATOR_SET}(?:\s*\|\|\s*${COMPARATOR_SET})*\s*$`,
);
const MAX_SEMVER_RANGE_LENGTH = 256;

export type ValidPlugin = {
	readonly name: string;
	readonly version: string;
	readonly requires: ReadonlyMap<string, string>;
	readonly capabilities: readonly string[];
	readonly operations: readonly RegisteredOperation[];
	readonly events: readonly RegisteredEvent[];
	readonly subscriptions: readonly RegisteredSubscription[];
	readonly jobs: readonly RegisteredJob[];
	loadMigrations(): Promise<readonly Migration[]>;
	activate(ctx: PluginContext): Promise<void>;
	deactivate(): Promise<void>;
};

export type UnvalidatedPlugin = {
	readonly declaredName: string;
	readonly version: unknown;
	readonly definition: unknown;
	readonly loadMigrations: (() => Promise<readonly Migration[]>) | undefined;
};

export type PluginValidation =
	| { readonly valid: true; readonly plugin: ValidPlugin }
	| { readonly valid: false; readonly problems: readonly string[] };

export function validatePlugin(
	{ declaredName, version, definition, loadMigrations }: UnvalidatedPlugin,
	offeredCapabilities: readonly string[],
): PluginValidation {
	if (!isRecord(definition)) {
		return {
			valid: false,
			problems: ["default export must be a plugin definition"],
		};
	}
	const requires = readRequires(definition.manifest);
	const capabilities = readCapabilities(
		definition.manifest,
		offeredCapabilities,
	);
	const operations = readOperations(
		{ kind: "plugin", name: declaredName },
		definition.operations,
	);
	const events = readEvents(declaredName, definition.events);
	const subscriptions = readSubscriptions(
		declaredName,
		definition.subscriptions,
		capabilities.value,
	);
	const jobs = readJobs(declaredName, definition.jobs);
	const problems = [
		...nameProblems(definition.manifest, declaredName),
		...requires.problems,
		...capabilities.problems,
		...migrationProblems(loadMigrations, capabilities.value),
		...hookProblems(definition, "activate"),
		...hookProblems(definition, "deactivate"),
		...operations.problems,
		...events.problems,
		...subscriptions.problems,
		...jobs.problems,
	];
	if (!isSemVerVersion(version))
		problems.push("package.json version must be a SemVer version");
	if (!isSemVerVersion(version) || problems.length > 0)
		return { valid: false, problems };

	return {
		valid: true,
		plugin: {
			name: declaredName,
			version,
			requires: requires.value,
			capabilities: capabilities.value,
			operations: operations.value,
			events: events.value,
			subscriptions: subscriptions.value,
			jobs: jobs.value,
			loadMigrations: loadMigrations ?? (async () => []),
			activate: async (ctx) => {
				if (typeof definition.activate === "function")
					await definition.activate(ctx);
			},
			deactivate: async () => {
				if (typeof definition.deactivate === "function")
					await definition.deactivate();
			},
		},
	};
}

function nameProblems(
	manifest: unknown,
	declaredName: string,
): readonly string[] {
	if (!isRecord(manifest)) return ["manifest must be an object"];
	if (!isPluginName(manifest.name)) {
		return [
			"manifest.name must consist of lowercase letters, digits and hyphens and start with a letter",
		];
	}
	if (manifest.name === CORE_OWNER_NAME)
		return [
			`manifest.name must not be ${quote(CORE_OWNER_NAME)}, the name under which the core offers its own operations`,
		];
	if (manifest.name.length > MAX_PLUGIN_NAME_LENGTH)
		return [
			`manifest.name must have at most ${MAX_PLUGIN_NAME_LENGTH} characters`,
		];
	return manifest.name === declaredName
		? []
		: [
				`manifest.name ${quote(manifest.name)} differs from the plugin name ${quote(declaredName)} that package.json declares`,
			];
}

type Read<Value> = {
	readonly value: Value;
	readonly problems: readonly string[];
};

function readRequires(manifest: unknown): Read<ReadonlyMap<string, string>> {
	const requires = isRecord(manifest) ? manifest.requires : undefined;
	if (requires === undefined) return { value: new Map(), problems: [] };
	if (!isRecord(requires)) {
		return {
			value: new Map(),
			problems: ["manifest.requires must be an object"],
		};
	}
	const value = new Map<string, string>();
	const problems: string[] = [];
	for (const [required, range] of Object.entries(requires)) {
		if (!isPluginName(required)) {
			problems.push(
				`manifest.requires names ${quote(required)}, which is not a plugin name`,
			);
		} else if (!isSemVerRange(range)) {
			problems.push(
				`manifest.requires.${required} must be a SemVer range such as "^1.2.0"`,
			);
		} else {
			value.set(required, range);
		}
	}
	return { value, problems };
}

function readCapabilities(
	manifest: unknown,
	offered: readonly string[],
): Read<readonly string[]> {
	const capabilities = isRecord(manifest) ? manifest.capabilities : undefined;
	if (capabilities === undefined) return { value: [], problems: [] };
	if (
		!Array.isArray(capabilities) ||
		!capabilities.every((capability) => typeof capability === "string")
	) {
		return {
			value: [],
			problems: ["manifest.capabilities must be a list of capability names"],
		};
	}
	const declared: readonly string[] = [...new Set<string>(capabilities)];
	return {
		value: declared,
		problems: declared
			.filter(
				(capability) =>
					!offered.includes(capability) &&
					!isEventSubscriptionCapability(capability),
			)
			.map(
				(capability) =>
					`manifest.capabilities names ${quote(capability)}, which this instance does not offer`,
			),
	};
}

function migrationProblems(
	loadMigrations: UnvalidatedPlugin["loadMigrations"],
	capabilities: readonly string[],
): readonly string[] {
	return loadMigrations === undefined ||
		capabilities.includes(DATABASE_CAPABILITY)
		? []
		: [
				`package.json declares migrations, but manifest.capabilities does not name ${quote(DATABASE_CAPABILITY)}`,
			];
}

function hookProblems(
	definition: Readonly<Record<string, unknown>>,
	hook: "activate" | "deactivate",
): readonly string[] {
	const value = definition[hook];
	return value === undefined || typeof value === "function"
		? []
		: [`${hook} must be a function`];
}

function isSemVerRange(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= MAX_SEMVER_RANGE_LENGTH &&
		SEMVER_RANGE.test(value)
	);
}

function isSemVerVersion(value: unknown): value is string {
	return typeof value === "string" && SEMVER_VERSION.test(value);
}
