import {
	type Actor,
	OPERATION_KINDS,
	OPERATION_TARGETS,
	type OperationContext,
	type OperationKind,
	type OperationTarget,
	type Schema,
	type Sql,
	type StartRole,
} from "@workbench/sdk";
import { isRecord } from "./is-record.ts";
import { type JsonSchema, jsonSchemaReaderOf } from "./json-schema.ts";
import { describeOwner, type Owner, ownerName } from "./owner.ts";
import { isPluginName } from "./plugin-name.ts";
import { quote } from "./quote.ts";
import { type DeclaredRights, isRightOf } from "./rights.ts";
import { type Validator, validatorOf } from "./schema-validation.ts";

export type RoleGrant = {
	readonly by: "role";
	readonly grantedTo: ReadonlySet<StartRole>;
};

export type InstanceAdminGrant = { readonly by: "instance_admin" };

export type EveryActorGrant = { readonly by: "every_actor" };

export type InstanceContext = {
	readonly actor: Actor;
	readonly sql: Sql;
	readonly grantableRights: ReadonlySet<string>;
	now(): Date;
	newId(): string;
};

type DescribedOperation = {
	readonly name: string;
	readonly owner: Owner;
	readonly kind: OperationKind;
	readonly right: string;
	readonly validateInput: Validator;
	readonly validateOutput: Validator;
	describeInput(): JsonSchema;
	describeOutput(): JsonSchema;
};

export type WorkspaceOperation = DescribedOperation & {
	readonly scope: "workspace";
	readonly target: OperationTarget;
	readonly grant: RoleGrant | InstanceAdminGrant;
	execute(input: unknown, ctx: OperationContext): Promise<unknown>;
};

export type InstanceOperation = DescribedOperation & {
	readonly scope: "instance";
	readonly grant: InstanceAdminGrant | EveryActorGrant;
	execute(input: unknown, ctx: InstanceContext): Promise<unknown>;
};

export type RegisteredOperation = WorkspaceOperation | InstanceOperation;

export type OperationScope = RegisteredOperation["scope"];

export type InstanceOperationDefinition<Input, Output> = {
	readonly name: string;
	readonly kind: OperationKind;
	readonly right: string;
	readonly input: Schema<Input>;
	readonly output: Schema<Output>;
	execute(input: Input, ctx: InstanceContext): Promise<Output>;
};

export function defineInstanceOperation<Input, Output>(
	definition: InstanceOperationDefinition<Input, Output>,
): InstanceOperationDefinition<Input, Output> {
	return definition;
}

export class InvalidInstanceOperationError extends Error {
	constructor(name: string) {
		super(
			`the instance operation ${quote(name)} must be named in camelCase, name a right of its owner and declare its input and output as schemas`,
		);
		this.name = "InvalidInstanceOperationError";
	}
}

export function instanceOperationOf(
	owner: Owner,
	definition: InstanceOperationDefinition<unknown, unknown>,
	grant: InstanceAdminGrant | EveryActorGrant,
): InstanceOperation {
	const validateInput = validatorOf(definition.input);
	const validateOutput = validatorOf(definition.output);
	if (
		!OPERATION_NAME.test(definition.name) ||
		!isRightOf(owner, definition.right) ||
		validateInput === undefined ||
		validateOutput === undefined
	)
		throw new InvalidInstanceOperationError(definition.name);
	return {
		name: qualifiedOperationName({
			plugin: ownerName(owner),
			name: definition.name,
		}),
		owner,
		kind: definition.kind,
		right: definition.right,
		scope: "instance",
		grant,
		validateInput,
		validateOutput,
		describeInput: jsonSchemaReaderOf(definition.input, "input"),
		describeOutput: jsonSchemaReaderOf(definition.output, "output"),
		execute: (value, ctx) => definition.execute(value, ctx),
	};
}

export type OperationRegistry = {
	find(name: string): RegisteredOperation | undefined;
	list(): readonly RegisteredOperation[];
};

export type OperationsRead = {
	readonly value: readonly WorkspaceOperation[];
	readonly problems: readonly string[];
};

export const OPERATION_NAME = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;

export const OPERATION_NAME_SEPARATOR = ".";

export type QualifiedOperationName = {
	readonly plugin: string;
	readonly name: string;
};

export function qualifiedOperationName({
	plugin,
	name,
}: QualifiedOperationName): string {
	return `${plugin}${OPERATION_NAME_SEPARATOR}${name}`;
}

export function findQualifiedOperationName(
	operation: string,
): QualifiedOperationName | undefined {
	const separator = operation.indexOf(OPERATION_NAME_SEPARATOR);
	if (separator < 0) return undefined;
	const plugin = operation.slice(0, separator);
	const name = operation.slice(separator + OPERATION_NAME_SEPARATOR.length);
	if (!isPluginName(plugin) || !OPERATION_NAME.test(name)) return undefined;
	return { plugin, name };
}

export function readOperations(
	owner: Owner,
	declared: unknown,
	rights: DeclaredRights,
): OperationsRead {
	if (declared === undefined) return { value: [], problems: [] };
	if (!Array.isArray(declared))
		return { value: [], problems: ["operations must be a list of operations"] };
	const value: WorkspaceOperation[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const [position, candidate] of declared.entries()) {
		const read = readOperation(owner, rights, position, candidate);
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
	| { readonly valid: true; readonly operation: WorkspaceOperation }
	| { readonly valid: false; readonly problems: readonly string[] };

function readOperation(
	owner: Owner,
	rights: DeclaredRights,
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
	const fullName = qualifiedOperationName({ plugin: prefix, name });
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
		isRightOf(owner, right) ? right : undefined,
		`${operation} must name exactly one right of ${describeOwner(owner)}, such as ${quote(`${prefix}.workspace.edit`)}`,
	);
	const grantedTo =
		validRight === undefined ? undefined : rights.get(validRight);
	if (validRight !== undefined && grantedTo === undefined)
		problems.push(
			`${operation} must name a right that ${describeOwner(owner)} declares in rights, not ${quote(validRight)}`,
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
		grantedTo === undefined ||
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
			scope: "workspace",
			target: validTarget,
			right: validRight,
			grant: { by: "role", grantedTo },
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
