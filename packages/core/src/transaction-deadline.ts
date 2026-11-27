import { SQL } from "bun";
import { z } from "zod";
import { describeThrown } from "./failure-reason.ts";
import {
	type HookOutcome,
	type HookTimeout,
	runWithin,
} from "./hook-timeout.ts";
import type { Logger } from "./logger.ts";

export type TransactionDeadline = {
	readonly timeout: HookTimeout;
	readonly cancellation: SQL;
	readonly logger: Logger;
};

export type TransactionStatements = (
	strings: TemplateStringsArray,
	...values: readonly unknown[]
) => Promise<readonly unknown[]>;

export type TransactionHook = (within: {
	readonly sql: TransactionStatements;
	readonly expired: AbortSignal;
}) => Promise<void>;

export class StatementRefusedError extends Error {
	constructor() {
		super("statement refused: the time of its hook is up");
		this.name = "StatementRefusedError";
	}
}

const CANCELLATION_CONNECTION_TIMEOUT_S = 5;

const CANCELLATION_IDLE_TIMEOUT_S = 30;

const backend = z.object({ pid: z.number().int() });

export function openStatementCancellation(
	url: string,
	statementTimeoutMs: number,
): SQL {
	return new SQL(url, {
		max: 1,
		connectionTimeout: CANCELLATION_CONNECTION_TIMEOUT_S,
		idleTimeout: CANCELLATION_IDLE_TIMEOUT_S,
		connection: { statement_timeout: statementTimeoutMs },
	});
}

export async function runInTransactionWithin(
	transaction: SQL,
	hook: TransactionHook,
	{ timeout, cancellation, logger }: TransactionDeadline,
): Promise<HookOutcome> {
	const [row]: unknown[] = await transaction`SELECT pg_backend_pid() AS pid`;
	const { pid } = backend.parse(row);
	const outcome = await runWithin(
		(expired) => hook({ sql: statementsUntil(expired, transaction), expired }),
		timeout,
	);
	if (outcome === "timed_out")
		await cancelStatementInFlight(cancellation, pid, logger);
	return outcome;
}

function statementsUntil(
	expired: AbortSignal,
	transaction: SQL,
): TransactionStatements {
	return async (strings, ...values) => {
		if (expired.aborted) throw new StatementRefusedError();
		return await transaction(strings, ...values);
	};
}

async function cancelStatementInFlight(
	cancellation: SQL,
	backendPid: number,
	logger: Logger,
): Promise<void> {
	try {
		await cancellation`SELECT pg_cancel_backend(${backendPid})`;
	} catch (error) {
		logger.error("statement not cancelled", { error: describeThrown(error) });
	}
}
