import type { EventDefinition } from "./event.ts";
import type { JobDefinition } from "./job.ts";

export const OPERATION_KINDS = ["query", "mutation"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_TARGETS = ["object", "workspace"] as const;
export type OperationTarget = (typeof OPERATION_TARGETS)[number];

export type SchemaIssue = {
	readonly message: string;
	readonly path?:
		| ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
		| undefined;
};

export type SchemaResult<Value> =
	| { readonly value: Value; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<SchemaIssue> };

export type Schema<Value> = {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (
			value: unknown,
		) => SchemaResult<Value> | Promise<SchemaResult<Value>>;
	};
};

export const ACTOR_KINDS = ["user", "service_account"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type Actor = {
	readonly kind: ActorKind;
	readonly id: string;
};

export const START_ROLES = ["owner", "editor", "viewer"] as const;
export type StartRole = (typeof START_ROLES)[number];

export type RightDefinition = {
	readonly name: string;
	readonly defaultRoles: readonly StartRole[];
};

export function defineRight(definition: RightDefinition): RightDefinition {
	return definition;
}

export type AccessedObject = {
	readonly workspace: string;
	readonly holder: Actor | null;
};

export type OperationAuth = {
	requireAccess<Accessed extends AccessedObject>(
		object: Accessed | undefined,
	): Accessed;
};

export type Sql = (
	strings: TemplateStringsArray,
	...values: readonly unknown[]
) => Promise<readonly unknown[]>;

export type OperationContext = {
	readonly actor: Actor;
	readonly workspace: string;
	readonly auth: OperationAuth;
	readonly sql: Sql;
	now(): Date;
	newId(): string;
	random(): number;
	publish<Payload>(
		event: EventDefinition<Payload>,
		payload: Payload,
	): Promise<void>;
	enqueue<Payload>(
		job: JobDefinition<Payload>,
		payload: Payload,
	): Promise<void>;
};

export type OperationDefinition<Input, Output> = {
	readonly name: string;
	readonly kind: OperationKind;
	readonly target: OperationTarget;
	readonly right: string;
	readonly input: Schema<Input>;
	readonly output: Schema<Output>;
	execute(input: Input, ctx: OperationContext): Promise<Output>;
};

export function defineOperation<Input, Output>(
	definition: OperationDefinition<Input, Output>,
): OperationDefinition<Input, Output> {
	return definition;
}

export type OperationErrorKind = "not_found" | "conflict" | "rejected";

const ERROR_CODE = /^[a-z][a-z0-9_]*$/;

export class InvalidErrorCodeError extends Error {
	constructor(code: string) {
		super(
			`error code "${code}" must consist of lowercase letters, digits and underscores and start with a letter`,
		);
		this.name = "InvalidErrorCodeError";
	}
}

export class OperationError extends Error {
	readonly kind: OperationErrorKind;
	readonly code: string;

	constructor(kind: OperationErrorKind, code: string, detail: string) {
		if (!ERROR_CODE.test(code)) throw new InvalidErrorCodeError(code);
		super(detail);
		this.name = "OperationError";
		this.kind = kind;
		this.code = code;
	}
}
