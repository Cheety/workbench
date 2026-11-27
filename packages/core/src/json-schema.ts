import { isRecord } from "./is-record.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type SchemaDirection = "input" | "output";

const JSON_SCHEMA_TARGET = "draft-2020-12";

const ANY_JSON: JsonSchema = {};

export function jsonSchemaReaderOf(
	schema: unknown,
	direction: SchemaDirection,
): () => JsonSchema {
	return () => {
		if (!isRecord(schema)) return ANY_JSON;
		const standard = schema["~standard"];
		if (!isRecord(standard) || !isRecord(standard.jsonSchema)) return ANY_JSON;
		const convert = standard.jsonSchema[direction];
		if (typeof convert !== "function") return ANY_JSON;
		const converted: unknown = convert.call(standard.jsonSchema, {
			target: JSON_SCHEMA_TARGET,
		});
		if (!isRecord(converted)) throw new InvalidJsonSchemaError(direction);
		const { $schema: _dialect, ...described } = converted;
		return described;
	};
}

export class InvalidJsonSchemaError extends Error {
	constructor(direction: SchemaDirection) {
		super(
			`the ${direction} schema described itself as something other than a JSON Schema object`,
		);
		this.name = "InvalidJsonSchemaError";
	}
}
