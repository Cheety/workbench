import {
	type Actor,
	type OperationContext,
	OperationError,
	type OperationErrorKind,
	type OperationKind,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { type NewAuditEntry, recordAuditEntry } from "./audit.ts";
import { recordEvent } from "./event-outbox.ts";
import type { EventRegistry } from "./event-registry.ts";
import { describeThrown } from "./failure-reason.ts";
import type { Logger } from "./logger.ts";
import {
	type OperationOwner,
	type OperationRegistry,
	ownerName,
	type RegisteredOperation,
} from "./operation-registry.ts";
import { quote } from "./quote.ts";
import {
	CORE_SCHEMA,
	pluginSchemaName,
	type SchemaName,
} from "./schema-name.ts";
import type { ValidationIssue } from "./schema-validation.ts";
import { workspaceExists } from "./workspaces.ts";

export type OperationCall = {
	readonly operation: string;
	readonly actor: Actor;
	readonly apiTokenId: string | null;
	readonly workspace: string;
	readonly input: unknown;
	readonly correlationId: string;
};

export type FailureKind = OperationErrorKind | "invalid_input" | "internal";

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
	readonly random: () => number;
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

const WORKSPACE_NOT_FOUND: OperationFailure = {
	code: "workspace_not_found",
	kind: "not_found",
	detail: "the workspace does not exist",
	issues: [],
};

class WorkspaceNotFoundError extends Error {
	constructor() {
		super(WORKSPACE_NOT_FOUND.detail);
		this.name = "WorkspaceNotFoundError";
	}
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
	const logger = options.logger.with({
		correlationId: call.correlationId,
		operation: operation.name,
	});
	try {
		const input = await operation.validateInput(call.input);
		if (!input.valid)
			return failed({
				code: "invalid_input",
				kind: "invalid_input",
				detail: "the input does not match the input schema of the operation",
				issues: input.issues,
			});
		const publisher = publisherOf(call, operation, options);
		const output = await inTransaction(
			operation,
			options.sql,
			async (transaction) => {
				await requireWorkspace(transaction, call.workspace);
				const executed = await execute(
					operation,
					input.value,
					contextOf(
						call,
						transaction,
						options,
						publisher.publishIn(transaction),
					),
				);
				if (IS_AUDITED[operation.kind])
					await recordAuditEntry(
						transaction,
						newAuditEntryOf(call, operation, options),
					);
				return executed;
			},
		);
		if (publisher.hasPublished()) options.eventsCommitted();
		return { ok: true, output };
	} catch (error) {
		return failed(logAndMapFailure(error, logger, operation.owner));
	}
}

const BEGIN_TRANSACTION: Record<
	OperationKind,
	(sql: SQL, body: (transaction: SQL) => Promise<unknown>) => Promise<unknown>
> = {
	query: (sql, body) => sql.begin("read only", body),
	mutation: (sql, body) => sql.begin(body),
};

const IS_AUDITED: Record<OperationKind, boolean> = {
	query: false,
	mutation: true,
};

const CAN_PUBLISH: Record<OperationKind, boolean> = {
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

function schemaOf(owner: OperationOwner): SchemaName {
	switch (owner.kind) {
		case "core":
			return CORE_SCHEMA;
		case "plugin":
			return pluginSchemaName(owner.name);
	}
}

async function requireWorkspace(
	transaction: SQL,
	workspace: string,
): Promise<void> {
	if (!(await workspaceExists(transaction, workspace)))
		throw new WorkspaceNotFoundError();
}

function contextOf(
	call: OperationCall,
	transaction: SQL,
	sources: Pick<OperationPipelineOptions, "now" | "newId" | "random">,
	publish: OperationContext["publish"],
): OperationContext {
	return {
		actor: call.actor,
		workspace: call.workspace,
		sql: transaction,
		now: sources.now,
		newId: sources.newId,
		random: sources.random,
		publish,
	};
}

type Publisher = {
	publishIn(transaction: SQL): OperationContext["publish"];
	hasPublished(): boolean;
};

function publisherOf(
	call: OperationCall,
	operation: RegisteredOperation,
	sources: Pick<OperationPipelineOptions, "events" | "now" | "newEventId">,
): Publisher {
	let hasPublished = false;
	return {
		publishIn: (transaction) => async (definition, payload) => {
			if (!CAN_PUBLISH[operation.kind])
				throw new EventPublishedByQueryError(operation.name);
			await recordEvent(transaction, sources.events, {
				id: sources.newEventId(),
				publisher: ownerName(operation.owner),
				definition,
				payload,
				occurredAt: sources.now(),
				workspace: call.workspace,
			});
			hasPublished = true;
		},
		hasPublished: () => hasPublished,
	};
}

function newAuditEntryOf(
	call: OperationCall,
	operation: RegisteredOperation,
	sources: Pick<OperationPipelineOptions, "now" | "newAuditEntryId">,
): NewAuditEntry {
	return {
		id: sources.newAuditEntryId(),
		occurredAt: sources.now(),
		actor: call.actor,
		apiTokenId: call.apiTokenId,
		operation: operation.name,
		workspace: call.workspace,
	};
}

async function execute(
	operation: RegisteredOperation,
	input: unknown,
	ctx: OperationContext,
): Promise<unknown> {
	const output = await operation.validateOutput(
		await runExecute(operation, input, ctx),
	);
	if (!output.valid) throw new InvalidOutputError(output.issues);
	return output.value;
}

async function runExecute(
	operation: RegisteredOperation,
	input: unknown,
	ctx: OperationContext,
): Promise<unknown> {
	try {
		return await operation.execute(input, ctx);
	} catch (error) {
		if (error instanceof OperationError) throw error;
		throw new ExecuteThrewError(error);
	}
}

function logAndMapFailure(
	error: unknown,
	logger: Logger,
	owner: OperationOwner,
): OperationFailure {
	if (error instanceof WorkspaceNotFoundError) return WORKSPACE_NOT_FOUND;
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
