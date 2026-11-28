import {
	OPERATION_KINDS,
	OPERATION_TARGETS,
	type OperationContext,
	type OperationKind,
	type OperationTarget,
} from "@workbench/sdk";
import { isRecord } from "./is-record.ts";
import { type JsonSchema, jsonSchemaReaderOf } from "./json-schema.ts";
import { describeOwner, type Owner, ownerName } from "./owner.ts";
import { quote } from "./quote.ts";
import { type Validator, validatorOf } from "./schema-validation.ts";

export type RegisteredOperation = {
	readonly name: string;
	readonly owner: Owner;
	readonly kind: OperationKind;
	readonly target: OperationTarget;
	readonly right: string;
	readonly validateInput: Validator;
	readonly validateOutput: Validator;
	describeInput(): JsonSchema;
	describeOutput(): JsonSchema;
	execute(input: unknown, ctx: OperationContext): Promise<unknown>;
};

export type OperationRegistry = {
	find(name: string): RegisteredOperation | undefined;
	list(): readonly RegisteredOperation[];
};

export type OperationsRead = {
	readonly value: readonly RegisteredOperation[];
	readonly problems: readonly string[];
};

export const OPERATION_NAME = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;

const RIGHT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export function readOperations(
	owner: Owner,
	declared: unknown,
): OperationsRead {
	if (declared === undefined) return { value: [], problems: [] };
	if (!Array.isArray(declared))
		return { value: [], problems: ["operations must be a list of operations"] };
	const value: RegisteredOperation[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const [position, candidate] of declared.entries()) {
		const read = readOperation(owner, position, candidate);
		if (!read.valid) {
			problems.push(...read.problems);
			continue;
		}
		if (seen.has(read.operation.name)) {
			problems.push(
				`operation ${quote(read.operation.name)} is declared more than once`,
			);
			continue;
		}
		seen.add(read.operation.name);
		value.push(read.operation);
	}
	return { value, problems };
}

type OperationRead =
	| { readonly valid: true; readonly operation: RegisteredOperation }
	| { readonly valid: false; readonly problems: readonly string[] };

function readOperation(
	owner: Owner,
	position: number,
	candidate: unknown,
): OperationRead {
	if (!isRecord(candidate))
		return {
			valid: false,
			problems: [`operations[${position}] must be an operation`],
		};
	const { name, kind, target, right, input, output, execute } = candidate;
	if (typeof name !== "string" || !OPERATION_NAME.test(name))
		return {
			valid: false,
			problems: [
				`operations[${position}].name must be a verb and an object in camelCase, such as "renameWorkspace"`,
			],
		};
	const prefix = ownerName(owner);
	const fullName = `${prefix}.${name}`;
	const operation = `operation ${quote(fullName)}`;
	const problems: string[] = [];
	const accepted = <Value>(
		value: Value | undefined,
		problem: string,
	): Value | undefined => {
		if (value === undefined) problems.push(problem);
		return value;
	};
	const validKind = accepted(
		isOneOf(kind, OPERATION_KINDS) ? kind : undefined,
		`${operation} must be of kind ${alternatives(OPERATION_KINDS)}`,
	);
	const validTarget = accepted(
		isOneOf(target, OPERATION_TARGETS) ? target : undefined,
		`${operation} must target ${alternatives(OPERATION_TARGETS)}`,
	);
	const validRight = accepted(
		isRightOf(prefix, right) ? right : undefined,
		`${operation} must name exactly one right of ${describeOwner(owner)}, such as ${quote(`${prefix}.workspace.edit`)}`,
	);
	const validateInput = accepted(
		validatorOf(input),
		`${operation} must declare its input as a schema`,
	);
	const validateOutput = accepted(
		validatorOf(output),
		`${operation} must declare its output as a schema`,
	);
	const validExecute = accepted(
		typeof execute === "function" ? execute : undefined,
		`${operation} must have an execute function`,
	);
	if (
		validKind === undefined ||
		validTarget === undefined ||
		validRight === undefined ||
		validateInput === undefined ||
		validateOutput === undefined ||
		validExecute === undefined
	)
		return { valid: false, problems };
	return {
		valid: true,
		operation: {
			name: fullName,
			owner,
			kind: validKind,
			target: validTarget,
			right: validRight,
			validateInput,
			validateOutput,
			describeInput: jsonSchemaReaderOf(input, "input"),
			describeOutput: jsonSchemaReaderOf(output, "output"),
			execute: async (value, ctx) => {
				const result: unknown = await validExecute.call(candidate, value, ctx);
				return result;
			},
		},
	};
}

function alternatives(members: readonly string[]): string {
	return members.map(quote).join(" or ");
}

function isOneOf<Member extends string>(
	value: unknown,
	members: readonly Member[],
): value is Member {
	return members.some((member) => member === value);
}

function isRightOf(prefix: string, right: unknown): right is string {
	return (
		typeof right === "string" &&
		right.startsWith(`${prefix}.`) &&
		RIGHT_NAME.test(right)
	);
}

export function registerOperations(
	operations: readonly RegisteredOperation[],
): OperationRegistry {
	const byName = new Map(
		operations.map((operation) => [operation.name, operation]),
	);
	return {
		find: (name) => byName.get(name),
		list: () => [...byName.values()],
	};
}
