import { isRecord } from "./is-record.ts";

export type ValidationIssue = {
	readonly path: readonly (string | number)[];
	readonly message: string;
};

export type Validation =
	| { readonly valid: true; readonly value: unknown }
	| { readonly valid: false; readonly issues: readonly ValidationIssue[] };

export type Validator = (value: unknown) => Promise<Validation>;

export class InvalidSchemaResultError extends Error {
	constructor() {
		super("the schema returned a result that is not a Standard Schema result");
		this.name = "InvalidSchemaResultError";
	}
}

export function validatorOf(schema: unknown): Validator | undefined {
	if (!isRecord(schema)) return undefined;
	const standard = schema["~standard"];
	if (!isRecord(standard)) return undefined;
	const validate = standard.validate;
	if (typeof validate !== "function") return undefined;
	return async (value) => {
		const result: unknown = await validate.call(standard, value);
		return readResult(result);
	};
}

function readResult(result: unknown): Validation {
	if (!isRecord(result)) throw new InvalidSchemaResultError();
	if (result.issues === undefined) return { valid: true, value: result.value };
	if (!Array.isArray(result.issues)) throw new InvalidSchemaResultError();
	return { valid: false, issues: result.issues.map(readIssue) };
}

function readIssue(issue: unknown): ValidationIssue {
	if (!isRecord(issue) || typeof issue.message !== "string")
		throw new InvalidSchemaResultError();
	return {
		path: Array.isArray(issue.path) ? issue.path.map(readPathSegment) : [],
		message: issue.message,
	};
}

function readPathSegment(segment: unknown): string | number {
	const key = isRecord(segment) ? segment.key : segment;
	return typeof key === "number" ? key : String(key);
}
