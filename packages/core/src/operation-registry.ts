import {
	OPERATION_KINDS,
	OPERATION_TARGETS,
	type OperationContext,
	type OperationKind,
	type OperationTarget,
} from "@workbench/sdk";
import { quote } from "./quote.ts";
import { isRecord, type Validator, validatorOf } from "./schema-validation.ts";

export type RegisteredOperation = {
	readonly name: string;
	readonly plugin: string;
	readonly kind: OperationKind;
	readonly target: OperationTarget;
	readonly right: string;
	readonly validateInput: Validator;
	readonly validateOutput: Validator;
	execute(input: unknown, ctx: OperationContext): Promise<unknown>;
};

export type OperationRegistry = {
	readonly names: readonly string[];
	find(name: string): RegisteredOperation | undefined;
};

export type OperationsRead = {
	readonly value: readonly RegisteredOperation[];
	readonly problems: readonly string[];
};

const OPERATION_NAME = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;

const RIGHT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export function readOperations(
	plugin: string,
	declared: unknown,
): OperationsRead {
	if (declared === undefined) return { value: [], problems: [] };
	if (!Array.isArray(declared))
		return { value: [], problems: ["operations must be a list of operations"] };
	const value: RegisteredOperation[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const [position, candidate] of declared.entries()) {
		const read = readOperation(plugin, position, candidate);
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
	plugin: string,
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
	const fullName = `${plugin}.${name}`;
	const validateInput = validatorOf(input);
	const validateOutput = validatorOf(output);
	if (
		isOneOf(kind, OPERATION_KINDS) &&
		isOneOf(target, OPERATION_TARGETS) &&
		isRightOf(plugin, right) &&
		validateInput !== undefined &&
		validateOutput !== undefined &&
		typeof execute === "function"
	)
		return {
			valid: true,
			operation: {
				name: fullName,
				plugin,
				kind,
				target,
				right,
				validateInput,
				validateOutput,
				execute: async (value, ctx) => {
					const result: unknown = await execute.call(candidate, value, ctx);
					return result;
				},
			},
		};
	const operation = `operation ${quote(fullName)}`;
	const problems: string[] = [];
	if (!isOneOf(kind, OPERATION_KINDS))
		problems.push(`${operation} must be of kind "query" or "mutation"`);
	if (!isOneOf(target, OPERATION_TARGETS))
		problems.push(`${operation} must target "object" or "workspace"`);
	if (!isRightOf(plugin, right))
		problems.push(
			`${operation} must name exactly one right of plugin ${quote(plugin)}, such as ${quote(`${plugin}.workspace.edit`)}`,
		);
	if (validateInput === undefined)
		problems.push(`${operation} must declare its input as a schema`);
	if (validateOutput === undefined)
		problems.push(`${operation} must declare its output as a schema`);
	if (typeof execute !== "function")
		problems.push(`${operation} must have an execute function`);
	return { valid: false, problems };
}

function isOneOf<Member extends string>(
	value: unknown,
	members: readonly Member[],
): value is Member {
	return members.some((member) => member === value);
}

function isRightOf(plugin: string, right: unknown): right is string {
	return (
		typeof right === "string" &&
		right.startsWith(`${plugin}.`) &&
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
		names: [...byName.keys()],
		find: (name) => byName.get(name),
	};
}
