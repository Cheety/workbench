import {
	type Actor,
	type OperationAuth,
	type OperationContext,
	OperationError,
	type OperationErrorKind,
	type OperationKind,
	type OperationTarget,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { isSameActor } from "./actor.ts";
import { type CallingToken, isInScope, type TokenScope } from "./api-tokens.ts";
import {
	type AuditOutcome,
	type DenialReason,
	type NewAuditEntry,
	recordAuditEntry,
} from "./audit.ts";
import type { Secret } from "./config.ts";
import { recordEvent } from "./event-outbox.ts";
import type { EventRegistry } from "./event-registry.ts";
import { describeThrown } from "./failure-reason.ts";
import {
	IDEMPOTENCY_KEY_RULE,
	type IdempotencyKey,
	IdempotencyKeyReusedError,
	parseIdempotencyKey,
	runIdempotently,
} from "./idempotency-keys.ts";
import { enqueueJob } from "./job-queue.ts";
import type { JobRegistry } from "./job-registry.ts";
import type { Logger } from "./logger.ts";
import { findMembership, type MembershipLock } from "./memberships.ts";
import type {
	InstanceContext,
	InstanceOperation,
	OperationRegistry,
	RegisteredOperation,
	WorkspaceOperation,
} from "./operation-registry.ts";
import { type Owner, ownerName, schemaOf } from "./owner.ts";
import { quote } from "./quote.ts";
import type { RoleName } from "./role-name.ts";
import { customRoleGrants, isStartRole } from "./roles.ts";
import type { ValidationIssue } from "./schema-validation.ts";
import { statementsIn } from "./transaction-statements.ts";

export type OperationCall = {
	readonly operation: string;
	readonly actor: Actor;
	readonly apiToken: CallingToken | null;
	readonly idempotencyKey: string | null;
	readonly workspace: string | null;
	readonly input: unknown;
	readonly correlationId: string;
};

export type FailureKind =
	| OperationErrorKind
	| "invalid_input"
	| "forbidden"
	| "internal";

export type OperationFailure = {
	readonly code: string;
	readonly kind: FailureKind;
	readonly detail: string;
	readonly issues: readonly ValidationIssue[];
};

export type OperationResult =
	| { readonly ok: true; readonly output: unknown }
	| { readonly ok: false; readonly failure: OperationFailure };

export type OperationPipelineOptions = {
	readonly sql: SQL;
	readonly registry: OperationRegistry;
	readonly events: EventRegistry;
	readonly now: () => Date;
	readonly newId: () => string;
	readonly newAuditEntryId: () => string;
	readonly newEventId: () => string;
	readonly eventsCommitted: () => void;
	readonly jobs: JobRegistry;
	readonly newJobId: () => string;
	readonly jobsCommitted: () => void;
	readonly random: () => number;
	readonly newApiToken: () => Secret;
	readonly isInstanceAdmin: (actor: Actor) => boolean;
	readonly logger: Logger;
};

export type OperationPipeline = {
	invoke(call: OperationCall): Promise<OperationResult>;
};

const INTERNAL_ERROR: OperationFailure = {
	code: "internal_error",
	kind: "internal",
	detail: "the operation failed for an internal reason",
	issues: [],
};

export const INVALID_IDEMPOTENCY_KEY: OperationFailure = {
	code: "invalid_idempotency_key",
	kind: "invalid_input",
	detail: `the idempotency key must consist of ${IDEMPOTENCY_KEY_RULE}`,
	issues: [],
};

const IDEMPOTENCY_KEY_REUSED: OperationFailure = {
	code: "idempotency_key_reused",
	kind: "rejected",
	detail:
		"the idempotency key was already used with another operation, workspace or input",
	issues: [],
};

const WORKSPACE_NOT_FOUND: OperationFailure = {
	code: "workspace_not_found",
	kind: "not_found",
	detail: "the workspace does not exist",
	issues: [],
};

const WORKSPACE_REQUIRED: OperationFailure = {
	code: "workspace_required",
	kind: "invalid_input",
	detail: "the operation runs on a workspace, but the call names none",
	issues: [],
};

export const WORKSPACE_NOT_EXPECTED: OperationFailure = {
	code: "workspace_not_expected",
	kind: "invalid_input",
	detail: "the operation runs on the instance, but the call names a workspace",
	issues: [],
};

const NOT_INSTANCE_ADMIN: OperationFailure = {
	code: "not_instance_admin",
	kind: "forbidden",
	detail: "only an instance admin may call the operation",
	issues: [],
};

const MISSING_RIGHT: OperationFailure = {
	code: "missing_right",
	kind: "forbidden",
	detail:
		"the role of the actor in the workspace does not grant the right of the operation",
	issues: [],
};

const OBJECT_NOT_FOUND: OperationFailure = {
	code: "object_not_found",
	kind: "not_found",
	detail: "the object does not exist",
	issues: [],
};

const NOT_OBJECT_HOLDER: OperationFailure = {
	code: "not_object_holder",
	kind: "forbidden",
	detail: "the object belongs to another actor",
	issues: [],
};

const OPERATION_OUTSIDE_TOKEN_SCOPE: OperationFailure = {
	code: "operation_outside_token_scope",
	kind: "forbidden",
	detail: "the API token of the call does not include the operation",
	issues: [],
};

const INSTANCE_OUTSIDE_TOKEN_SCOPE: OperationFailure = {
	code: "instance_outside_token_scope",
	kind: "forbidden",
	detail:
		"the API token of the call is limited to workspaces and cannot call an operation on the instance",
	issues: [],
};

const DENIALS: Record<DenialReason, OperationFailure> = {
	workspace_not_found: WORKSPACE_NOT_FOUND,
	missing_right: MISSING_RIGHT,
	object_not_found: OBJECT_NOT_FOUND,
	not_object_holder: NOT_OBJECT_HOLDER,
	not_instance_admin: NOT_INSTANCE_ADMIN,
	operation_outside_token_scope: OPERATION_OUTSIDE_TOKEN_SCOPE,
	workspace_outside_token_scope: WORKSPACE_NOT_FOUND,
	instance_outside_token_scope: INSTANCE_OUTSIDE_TOKEN_SCOPE,
};

const UNLIMITED_SCOPE: TokenScope = { operations: null, workspaces: null };

const INSTANCE_DENIALS: Record<
	InstanceOperation["grant"]["by"],
	readonly DenialReason[]
> = {
	instance_admin: ["not_instance_admin"],
	every_actor: [],
};

const WORKSPACE_DENIALS: Record<
	WorkspaceOperation["grant"]["by"],
	readonly DenialReason[]
> = {
	role: ["workspace_not_found", "missing_right"],
	instance_admin: ["workspace_not_found", "not_instance_admin"],
};

const OBJECT_DENIALS: Record<OperationTarget, readonly DenialReason[]> = {
	workspace: [],
	object: ["object_not_found", "not_object_holder"],
};

function denialReasonsOf(
	operation: RegisteredOperation,
): readonly DenialReason[] {
	switch (operation.scope) {
		case "instance":
			return [
				...INSTANCE_DENIALS[operation.grant.by],
				"instance_outside_token_scope",
				"operation_outside_token_scope",
			];
		case "workspace":
			return [
				...WORKSPACE_DENIALS[operation.grant.by],
				"workspace_outside_token_scope",
				"operation_outside_token_scope",
				...OBJECT_DENIALS[operation.target],
			];
	}
}

export function denialsOf(
	operation: RegisteredOperation,
): readonly OperationFailure[] {
	return [
		...new Set(denialReasonsOf(operation).map((reason) => DENIALS[reason])),
	];
}

class CallFailedError extends Error {
	readonly failure: OperationFailure;
	readonly denial: DenialReason | null;

	constructor(failure: OperationFailure, denial: DenialReason | null) {
		super(failure.detail);
		this.name = "CallFailedError";
		this.failure = failure;
		this.denial = denial;
	}
}

function failedCall(failure: OperationFailure): CallFailedError {
	return new CallFailedError(failure, null);
}

function deniedCall(reason: DenialReason): CallFailedError {
	return new CallFailedError(DENIALS[reason], reason);
}

function invalidInput(issues: readonly ValidationIssue[]): OperationFailure {
	return {
		code: "invalid_input",
		kind: "invalid_input",
		detail: "the input does not match the input schema of the operation",
		issues,
	};
}

class InvalidOutputError extends Error {
	readonly issues: readonly ValidationIssue[];

	constructor(issues: readonly ValidationIssue[]) {
		super("the output does not match the output schema of the operation");
		this.name = "InvalidOutputError";
		this.issues = issues;
	}
}

class EventPublishedByQueryError extends Error {
	constructor(operation: string) {
		super(
			`the query ${quote(operation)} published an event; only a mutation publishes events`,
		);
		this.name = "EventPublishedByQueryError";
	}
}

class JobEnqueuedByQueryError extends Error {
	constructor(operation: string) {
		super(
			`the query ${quote(operation)} enqueued a job; only a mutation enqueues jobs`,
		);
		this.name = "JobEnqueuedByQueryError";
	}
}

class ObjectAccessUncheckedError extends Error {
	constructor(operation: string) {
		super(
			`the operation ${quote(operation)} targets an object but never asked ctx.auth for access`,
		);
		this.name = "ObjectAccessUncheckedError";
	}
}

class ExecuteThrewError extends Error {
	constructor(cause: unknown) {
		super("the execute function of the operation threw", { cause });
		this.name = "ExecuteThrewError";
	}
}

export function createOperationPipeline(
	options: OperationPipelineOptions,
): OperationPipeline {
	return { invoke: (call) => invoke(call, options) };
}

type ScopedCall =
	| {
			readonly scope: "workspace";
			readonly operation: WorkspaceOperation;
			readonly workspace: string;
	  }
	| { readonly scope: "instance"; readonly operation: InstanceOperation };

type ScopedCallOf =
	| { readonly ok: true; readonly call: ScopedCall }
	| { readonly ok: false; readonly failure: OperationFailure };

function scopedCallOf(
	operation: RegisteredOperation,
	workspace: string | null,
): ScopedCallOf {
	switch (operation.scope) {
		case "workspace":
			return workspace === null
				? { ok: false, failure: WORKSPACE_REQUIRED }
				: { ok: true, call: { scope: "workspace", operation, workspace } };
		case "instance":
			return workspace === null
				? { ok: true, call: { scope: "instance", operation } }
				: { ok: false, failure: WORKSPACE_NOT_EXPECTED };
	}
}

async function invoke(
	call: OperationCall,
	options: OperationPipelineOptions,
): Promise<OperationResult> {
	const operation = options.registry.find(call.operation);
	if (operation === undefined)
		return failed({
			code: "unknown_operation",
			kind: "not_found",
			detail: `no operation is named ${quote(call.operation)}`,
			issues: [],
		});
	const scoped = scopedCallOf(operation, call.workspace);
	if (!scoped.ok) return failed(scoped.failure);
	const logger = loggerOf(call, operation, options.logger);
	const key = idempotencyKeyOf(call, operation);
	if (!key.valid) return failed(INVALID_IDEMPOTENCY_KEY);
	try {
		const publisher = publisherOf(operation, options);
		const enqueuer = enqueuerOf(operation, options);
		const output = await inTransaction(
			operation,
			options.sql,
			async (transaction) => {
				await authorize(
					transaction,
					call,
					scoped.call,
					options.isInstanceAdmin,
				);
				const input = await operation.validateInput(call.input);
				if (!input.valid) throw failedCall(invalidInput(input.issues));
				const run = async (): Promise<unknown> => {
					const executed = await executeScoped(
						scoped.call,
						input.value,
						{ call, transaction },
						{ options, publisher, enqueuer },
					);
					if (IS_AUDITED[operation.kind])
						await recordAuditEntry(
							transaction,
							newAuditEntryOf(call, operation, options, {
								result: "succeeded",
								subject: operation.auditSubjectOf(input.value, executed),
							}),
						);
					return executed;
				};
				if (key.key === null) return run();
				return runIdempotently(
					transaction,
					{
						actor: call.actor,
						key: key.key,
						operation: operation.name,
						workspace: call.workspace,
						input: call.input,
						calledAt: options.now(),
					},
					run,
				);
			},
		);
		if (publisher.hasPublished()) options.eventsCommitted();
		if (enqueuer.hasEnqueued()) options.jobsCommitted();
		return { ok: true, output };
	} catch (error) {
		if (error instanceof CallFailedError && error.denial !== null)
			return deny(call, operation, options, error.denial);
		return failed(logAndMapFailure(error, logger, operation.owner));
	}
}

type CallEffects = {
	readonly options: OperationPipelineOptions;
	readonly publisher: Publisher;
	readonly enqueuer: Enqueuer;
};

async function executeScoped(
	scoped: ScopedCall,
	input: unknown,
	{
		call,
		transaction,
	}: { readonly call: OperationCall; readonly transaction: SQL },
	{ options, publisher, enqueuer }: CallEffects,
): Promise<unknown> {
	const { actor } = call;
	switch (scoped.scope) {
		case "workspace": {
			const access = accessOf(scoped.workspace, actor);
			return executeOnWorkspace(
				scoped.operation,
				input,
				contextOf(
					{ actor, workspace: scoped.workspace, transaction },
					options,
					{
						auth: access.auth,
						publish: publisher.publishIn(transaction, scoped.workspace),
						enqueue: enqueuer.enqueueIn(transaction, scoped.workspace),
					},
				),
				access,
			);
		}
		case "instance":
			return executeOnInstance(scoped.operation, input, {
				actor,
				apiToken: call.apiToken,
				sql: statementsIn(transaction),
				grantableRights: options.registry.grantableRights(),
				operationNames: options.registry.operationNames(),
				now: options.now,
				newId: options.newId,
				newApiToken: options.newApiToken,
			});
	}
}

async function deny(
	call: OperationCall,
	operation: RegisteredOperation,
	options: OperationPipelineOptions,
	reason: DenialReason,
): Promise<OperationResult> {
	try {
		await options.sql.begin((transaction) =>
			recordAuditEntry(
				transaction,
				newAuditEntryOf(call, operation, options, { result: "denied", reason }),
			),
		);
	} catch (error) {
		return failed(
			logAndMapFailure(
				error,
				loggerOf(call, operation, options.logger),
				operation.owner,
			),
		);
	}
	return failed(DENIALS[reason]);
}

function loggerOf(
	call: OperationCall,
	operation: RegisteredOperation,
	logger: Logger,
): Logger {
	return logger.with({
		correlationId: call.correlationId,
		operation: operation.name,
	});
}

type IdempotencyKeyOfCall =
	| { readonly valid: true; readonly key: IdempotencyKey | null }
	| { readonly valid: false };

function idempotencyKeyOf(
	call: OperationCall,
	operation: RegisteredOperation,
): IdempotencyKeyOfCall {
	if (call.idempotencyKey === null || !operation.takesIdempotencyKey)
		return { valid: true, key: null };
	return parseIdempotencyKey(call.idempotencyKey);
}

const BEGIN_TRANSACTION: Record<
	OperationKind,
	(sql: SQL, body: (transaction: SQL) => Promise<unknown>) => Promise<unknown>
> = {
	query: (sql, body) => sql.begin("read only", body),
	mutation: (sql, body) => sql.begin("isolation level read committed", body),
};

const MEMBERSHIP_LOCK: Record<OperationKind, MembershipLock> = {
	query: "none",
	mutation: "share",
};

const IS_AUDITED: Record<OperationKind, boolean> = {
	query: false,
	mutation: true,
};

const CAN_PUBLISH: Record<OperationKind, boolean> = {
	query: false,
	mutation: true,
};

const CAN_ENQUEUE: Record<OperationKind, boolean> = {
	query: false,
	mutation: true,
};

function inTransaction(
	operation: RegisteredOperation,
	sql: SQL,
	run: (transaction: SQL) => Promise<unknown>,
): Promise<unknown> {
	const schema = schemaOf(operation.owner);
	const body = async (transaction: SQL): Promise<unknown> => {
		await transaction.unsafe(`SET LOCAL search_path TO "${schema}"`);
		return run(transaction);
	};
	return BEGIN_TRANSACTION[operation.kind](sql, body);
}

type AuthorizedCaller = {
	readonly actor: Actor;
	readonly scope: TokenScope;
};

async function authorize(
	transaction: SQL,
	call: OperationCall,
	scoped: ScopedCall,
	isInstanceAdmin: (actor: Actor) => boolean,
): Promise<void> {
	const caller: AuthorizedCaller = {
		actor: call.actor,
		scope: call.apiToken?.scope ?? UNLIMITED_SCOPE,
	};
	switch (scoped.scope) {
		case "instance":
			return authorizeOnInstance(caller, scoped.operation, isInstanceAdmin);
		case "workspace":
			return authorizeOnWorkspace(transaction, caller, scoped, isInstanceAdmin);
	}
}

function requireOperationInScope(
	scope: TokenScope,
	operation: RegisteredOperation,
): void {
	if (!isInScope(scope.operations, operation.name))
		throw deniedCall("operation_outside_token_scope");
}

function authorizeOnInstance(
	{ actor, scope }: AuthorizedCaller,
	operation: InstanceOperation,
	isInstanceAdmin: (actor: Actor) => boolean,
): void {
	if (scope.workspaces !== null)
		throw deniedCall("instance_outside_token_scope");
	requireOperationInScope(scope, operation);
	switch (operation.grant.by) {
		case "every_actor":
			return;
		case "instance_admin":
			if (!isInstanceAdmin(actor)) throw deniedCall("not_instance_admin");
	}
}

async function authorizeOnWorkspace(
	transaction: SQL,
	{ actor, scope }: AuthorizedCaller,
	{
		operation,
		workspace,
	}: { readonly operation: WorkspaceOperation; readonly workspace: string },
	isInstanceAdmin: (actor: Actor) => boolean,
): Promise<void> {
	const membership = await findMembership(
		transaction,
		workspace,
		actor,
		MEMBERSHIP_LOCK[operation.kind],
	);
	if (membership.kind === "no_workspace") throw failedCall(WORKSPACE_NOT_FOUND);
	if (!isInScope(scope.workspaces, workspace))
		throw deniedCall("workspace_outside_token_scope");
	const { grant } = operation;
	switch (grant.by) {
		case "instance_admin":
			if (isInstanceAdmin(actor))
				return requireOperationInScope(scope, operation);
			throw deniedCall(
				membership.kind === "member"
					? "not_instance_admin"
					: "workspace_not_found",
			);
		case "role":
			if (membership.kind === "not_member")
				throw deniedCall("workspace_not_found");
			requireOperationInScope(scope, operation);
			if (
				!(await roleGrants(transaction, membership.role, {
					right: operation.right,
					grantedTo: grant.grantedTo,
				}))
			)
				throw deniedCall("missing_right");
	}
}

async function roleGrants(
	transaction: SQL,
	role: RoleName,
	{
		right,
		grantedTo,
	}: { readonly right: string; readonly grantedTo: ReadonlySet<string> },
): Promise<boolean> {
	if (isStartRole(role)) return grantedTo.has(role);
	return customRoleGrants(transaction, role, right);
}

type CallAccess = {
	readonly auth: OperationAuth;
	throwRecordedDenial(): void;
	hasBeenChecked(): boolean;
};

const REQUIRES_ACCESS_CHECK: Record<OperationTarget, boolean> = {
	object: true,
	workspace: false,
};

function accessOf(workspace: string, actor: Actor): CallAccess {
	let recordedDenial: CallFailedError | undefined;
	let hasBeenChecked = false;
	const recordDenial = (reason: DenialReason): CallFailedError => {
		recordedDenial ??= deniedCall(reason);
		return recordedDenial;
	};
	return {
		auth: {
			requireAccess: (object) => {
				hasBeenChecked = true;
				if (object === undefined) throw failedCall(OBJECT_NOT_FOUND);
				if (object.workspace !== workspace)
					throw recordDenial("object_not_found");
				if (object.holder !== null && !isSameActor(object.holder, actor))
					throw recordDenial("not_object_holder");
				return object;
			},
		},
		throwRecordedDenial: () => {
			if (recordedDenial !== undefined) throw recordedDenial;
		},
		hasBeenChecked: () => hasBeenChecked,
	};
}

type WorkspaceTransaction = {
	readonly actor: Actor;
	readonly workspace: string;
	readonly transaction: SQL;
};

function contextOf(
	{ actor, workspace, transaction }: WorkspaceTransaction,
	sources: Pick<OperationPipelineOptions, "now" | "newId" | "random">,
	effects: Pick<OperationContext, "auth" | "publish" | "enqueue">,
): OperationContext {
	return {
		actor,
		workspace,
		auth: effects.auth,
		sql: statementsIn(transaction),
		now: sources.now,
		newId: sources.newId,
		random: sources.random,
		publish: effects.publish,
		enqueue: effects.enqueue,
	};
}

type Publisher = {
	publishIn(transaction: SQL, workspace: string): OperationContext["publish"];
	hasPublished(): boolean;
};

function publisherOf(
	operation: RegisteredOperation,
	sources: Pick<OperationPipelineOptions, "events" | "now" | "newEventId">,
): Publisher {
	let hasPublished = false;
	return {
		publishIn: (transaction, workspace) => async (definition, payload) => {
			if (!CAN_PUBLISH[operation.kind])
				throw new EventPublishedByQueryError(operation.name);
			await recordEvent(transaction, sources.events, {
				id: sources.newEventId(),
				publisher: ownerName(operation.owner),
				definition,
				payload,
				occurredAt: sources.now(),
				workspace,
			});
			hasPublished = true;
		},
		hasPublished: () => hasPublished,
	};
}

type Enqueuer = {
	enqueueIn(transaction: SQL, workspace: string): OperationContext["enqueue"];
	hasEnqueued(): boolean;
};

function enqueuerOf(
	operation: RegisteredOperation,
	sources: Pick<OperationPipelineOptions, "jobs" | "now" | "newJobId">,
): Enqueuer {
	let hasEnqueued = false;
	return {
		enqueueIn: (transaction, workspace) => async (definition, payload) => {
			if (!CAN_ENQUEUE[operation.kind])
				throw new JobEnqueuedByQueryError(operation.name);
			await enqueueJob(transaction, sources.jobs, {
				id: sources.newJobId(),
				owner: operation.owner,
				definition,
				payload,
				enqueuedAt: sources.now(),
				workspace,
			});
			hasEnqueued = true;
		},
		hasEnqueued: () => hasEnqueued,
	};
}

function newAuditEntryOf(
	call: OperationCall,
	operation: RegisteredOperation,
	sources: Pick<OperationPipelineOptions, "now" | "newAuditEntryId">,
	outcome: AuditOutcome,
): NewAuditEntry {
	return {
		id: sources.newAuditEntryId(),
		occurredAt: sources.now(),
		actor: call.actor,
		apiTokenId: call.apiToken?.id ?? null,
		operation: operation.name,
		workspace: call.workspace ?? auditedWorkspaceOf(outcome),
		outcome,
	};
}

function auditedWorkspaceOf(outcome: AuditOutcome): string | null {
	switch (outcome.result) {
		case "succeeded":
			return outcome.subject.workspace;
		case "denied":
			return null;
	}
}

async function executeOnWorkspace(
	operation: WorkspaceOperation,
	input: unknown,
	ctx: OperationContext,
	access: CallAccess,
): Promise<unknown> {
	const executed = await executedBy(async () => {
		try {
			return await operation.execute(input, ctx);
		} finally {
			access.throwRecordedDenial();
		}
	});
	if (REQUIRES_ACCESS_CHECK[operation.target] && !access.hasBeenChecked())
		throw new ObjectAccessUncheckedError(operation.name);
	return validOutputOf(operation, executed);
}

async function executeOnInstance(
	operation: InstanceOperation,
	input: unknown,
	ctx: InstanceContext,
): Promise<unknown> {
	return validOutputOf(
		operation,
		await executedBy(() => operation.execute(input, ctx)),
	);
}

async function executedBy(run: () => Promise<unknown>): Promise<unknown> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof OperationError || error instanceof CallFailedError)
			throw error;
		throw new ExecuteThrewError(error);
	}
}

async function validOutputOf(
	operation: RegisteredOperation,
	executed: unknown,
): Promise<unknown> {
	const output = await operation.validateOutput(executed);
	if (!output.valid) throw new InvalidOutputError(output.issues);
	return output.value;
}

function logAndMapFailure(
	error: unknown,
	logger: Logger,
	owner: Owner,
): OperationFailure {
	if (error instanceof CallFailedError) return error.failure;
	if (error instanceof IdempotencyKeyReusedError) return IDEMPOTENCY_KEY_REUSED;
	if (error instanceof OperationError)
		return {
			code: `${ownerName(owner)}.${error.code}`,
			kind: error.kind,
			detail: error.message,
			issues: [],
		};
	if (error instanceof InvalidOutputError)
		logger.error("operation failed", {
			reason: "invalid_output",
			issues: error.issues,
		});
	else if (error instanceof ObjectAccessUncheckedError)
		logger.error("operation failed", { reason: "object_access_unchecked" });
	else if (error instanceof ExecuteThrewError)
		logger.error("operation failed", {
			reason: "execute_threw",
			error: describeThrown(error.cause),
		});
	else
		logger.error("operation failed", {
			reason: "pipeline_failed",
			error: describeThrown(error),
		});
	return INTERNAL_ERROR;
}

function failed(failure: OperationFailure): OperationResult {
	return { ok: false, failure };
}
