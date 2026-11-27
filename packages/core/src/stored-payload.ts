import { isRecord } from "./is-record.ts";
import type { ValidationIssue, Validator } from "./schema-validation.ts";

export type StoredPayload =
	| { readonly valid: true; readonly json: string }
	| { readonly valid: false; readonly issues: readonly ValidationIssue[] };

type Path = ValidationIssue["path"];

const NO_JSON_FORM = "the payload has no JSON form";

const CHANGED_ON_READING =
	"the schema changes the stored form of the payload when it reads it again";

const UNSTORABLE_TEXT =
	"the payload contains text that Postgres cannot store as JSON: a NUL character or half a surrogate pair";

const NUL = "\u0000";

export async function storedPayloadOf(
	payload: unknown,
	validate: Validator,
): Promise<StoredPayload> {
	const given = await validate(payload);
	if (!given.valid) return given;
	const json = jsonOf(given.value);
	if (json === undefined) return rejectedAsAWhole(NO_JSON_FORM);
	const read: unknown = JSON.parse(json);
	const unstorable = pathsOfUnstorableText(read, []);
	if (unstorable.length > 0)
		return {
			valid: false,
			issues: unstorable.map((path) => ({ path, message: UNSTORABLE_TEXT })),
		};
	const stored = await validate(read);
	if (!stored.valid) return stored;
	if (jsonOf(stored.value) !== json)
		return rejectedAsAWhole(CHANGED_ON_READING);
	return { valid: true, json };
}

function rejectedAsAWhole(message: string): StoredPayload {
	return { valid: false, issues: [{ path: [], message }] };
}

function jsonOf(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch (error) {
		if (error instanceof TypeError) return undefined;
		throw error;
	}
}

function pathsOfUnstorableText(value: unknown, path: Path): Path[] {
	if (typeof value === "string") return isStorableText(value) ? [] : [path];
	if (Array.isArray(value))
		return value.flatMap((item, index) =>
			pathsOfUnstorableText(item, [...path, index]),
		);
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([key, item]) =>
		isStorableText(key)
			? pathsOfUnstorableText(item, [...path, key])
			: [[...path, key]],
	);
}

function isStorableText(text: string): boolean {
	return !text.includes(NUL) && text.isWellFormed();
}
