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
	hook: () => Promise<void>,
	{ timeout, cancellation, logger }: TransactionDeadline,
): Promise<HookOutcome> {
	const [row]: unknown[] = await transaction`SELECT pg_backend_pid() AS pid`;
	const { pid } = backend.parse(row);
	const outcome = await runWithin(hook, timeout);
	if (outcome === "timed_out")
		await cancelStatementInFlight(cancellation, pid, logger);
	return outcome;
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
