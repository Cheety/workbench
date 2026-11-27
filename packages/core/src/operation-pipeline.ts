import {
	type Actor,
	type OperationContext,
	OperationError,
	type OperationErrorKind,
	type OperationKind,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { describeThrown } from "./failure-reason.ts";
import type { Logger } from "./logger.ts";
import type {
	OperationRegistry,
	RegisteredOperation,
} from "./operation-registry.ts";
import { quote } from "./quote.ts";
import { pluginSchemaName } from "./schema-name.ts";
import type { InputIssue } from "./schema-validation.ts";
import { workspaceExists } from "./workspaces.ts";

export type OperationCall = {
	readonly operation: string;
	readonly actor: Actor;
	readonly workspace: string;
	readonly input: unknown;
	readonly correlationId: string;
};

export type FailureKind = OperationErrorKind | "invalid_input" | "internal";

export type OperationFailure = {
	readonly code: string;
	readonly kind: FailureKind;
	readonly detail: string;
	readonly issues: readonly InputIssue[];
};

export type OperationResult =
	| { readonly ok: true; readonly output: unknown }
	| { readonly ok: false; readonly failure: OperationFailure };

export type OperationPipelineOptions = {
	readonly sql: SQL;
	readonly registry: OperationRegistry;
	readonly now: () => Date;
	readonly newId: () => string;
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
	readonly issues: readonly InputIssue[];

	constructor(issues: readonly InputIssue[]) {
		super("the output does not match the output schema of the operation");
		this.name = "InvalidOutputError";
		this.issues = issues;
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
		const output = await inTransaction(operation, options, (sql) =>
			execute(operation, input.value, call, { ...options, sql }),
		);
		return { ok: true, output };
	} catch (error) {
		return failed(failureOf(error, logger, operation.plugin));
	}
}

const BEGIN_TRANSACTION: Record<
	OperationKind,
	(sql: SQL, body: (transaction: SQL) => Promise<unknown>) => Promise<unknown>
> = {
	query: (sql, body) => sql.begin("read only", body),
	mutation: (sql, body) => sql.begin(body),
};

function inTransaction(
	operation: RegisteredOperation,
	{ sql }: OperationPipelineOptions,
	run: (transaction: SQL) => Promise<unknown>,
): Promise<unknown> {
	const schema = pluginSchemaName(operation.plugin);
	const body = async (transaction: SQL): Promise<unknown> => {
		await transaction.unsafe(`SET LOCAL search_path TO "${schema}"`);
		return run(transaction);
	};
	return BEGIN_TRANSACTION[operation.kind](sql, body);
}

async function execute(
	operation: RegisteredOperation,
	input: unknown,
	call: OperationCall,
	options: OperationPipelineOptions,
): Promise<unknown> {
	if (!(await workspaceExists(options.sql, call.workspace)))
		throw new WorkspaceNotFoundError();
	const ctx: OperationContext = {
		actor: call.actor,
		workspace: call.workspace,
		sql: options.sql,
		now: options.now,
		newId: options.newId,
		random: options.random,
	};
	const output = await operation.validateOutput(
		await operation.execute(input, ctx),
	);
	if (!output.valid) throw new InvalidOutputError(output.issues);
	return output.value;
}

function failureOf(
	error: unknown,
	logger: Logger,
	plugin: string,
): OperationFailure {
	if (error instanceof WorkspaceNotFoundError) return WORKSPACE_NOT_FOUND;
	if (error instanceof OperationError)
		return {
			code: `${plugin}.${error.code}`,
			kind: error.kind,
			detail: error.message,
			issues: [],
		};
	if (error instanceof InvalidOutputError)
		logger.error("operation failed", {
			reason: "invalid_output",
			issues: error.issues,
		});
	else
		logger.error("operation failed", {
			reason: "use_case_failed",
			error: describeThrown(error),
		});
	return INTERNAL_ERROR;
}

function failed(failure: OperationFailure): OperationResult {
	return { ok: false, failure };
}
