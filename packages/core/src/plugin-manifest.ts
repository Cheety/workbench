import type { PluginContext } from "@workbench/sdk";
import { quote } from "./quote.ts";

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

// The grammar of semver.org, section "Is there a suggested regular expression".
const SEMVER_VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const VERSION_PART = String.raw`(?:0|[1-9]\d*|[xX*])`;
const PARTIAL_VERSION = String.raw`${VERSION_PART}(?:\.${VERSION_PART}(?:\.${VERSION_PART}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)?`;
const COMPARATOR = String.raw`(?:\^|~|>=|<=|>|<|=)?\s*${PARTIAL_VERSION}`;
const COMPARATOR_SET = String.raw`${COMPARATOR}(?:\s+${COMPARATOR})*`;
// Bun.semver.satisfies treats a range it cannot parse as satisfied, so a range
// has to be recognised before it is evaluated.
const SEMVER_RANGE = new RegExp(
	String.raw`^\s*${COMPARATOR_SET}(?:\s*\|\|\s*${COMPARATOR_SET})*\s*$`,
);

export function isPluginName(value: unknown): value is string {
	return typeof value === "string" && PLUGIN_NAME.test(value);
}

export type ValidPlugin = {
	readonly name: string;
	readonly version: string;
	/** Required plugin name → SemVer range. */
	readonly requires: ReadonlyMap<string, string>;
	readonly capabilities: readonly string[];
	activate(ctx: PluginContext): Promise<void>;
	deactivate(): Promise<void>;
};

export type UnvalidatedPlugin = {
	/** The plugin name the package's `package.json` declares. */
	readonly declaredName: string;
	readonly version: unknown;
	readonly definition: unknown;
};

export type PluginValidation =
	| { readonly valid: true; readonly plugin: ValidPlugin }
	| { readonly valid: false; readonly problems: readonly string[] };

export function validatePlugin(
	{ declaredName, version, definition }: UnvalidatedPlugin,
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
	const problems = [
		...nameProblems(definition.manifest, declaredName),
		...requires.problems,
		...capabilities.problems,
		...hookProblems(definition, "activate"),
		...hookProblems(definition, "deactivate"),
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
		} else if (typeof range !== "string" || !SEMVER_RANGE.test(range)) {
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
			.filter((capability) => !offered.includes(capability))
			.map(
				(capability) =>
					`manifest.capabilities names ${quote(capability)}, which this instance does not offer`,
			),
	};
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

function isSemVerVersion(value: unknown): value is string {
	return typeof value === "string" && SEMVER_VERSION.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
