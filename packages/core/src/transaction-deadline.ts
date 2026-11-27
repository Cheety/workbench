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
	readonly logger: Logger;
};

const CANCEL_CONNECTION_TIMEOUT_S = 5;

const backend = z.object({ pid: z.number().int() });

export async function runInTransactionWithin(
	transaction: SQL,
	hook: () => Promise<void>,
	{ timeout, logger }: TransactionDeadline,
): Promise<HookOutcome> {
	const [row]: unknown[] = await transaction`SELECT pg_backend_pid() AS pid`;
	const { pid } = backend.parse(row);
	const outcome = await runWithin(hook, timeout);
	if (outcome === "timed_out")
		await cancelStatementInFlight(transaction, pid, logger);
	return outcome;
}

async function cancelStatementInFlight(
	transaction: SQL,
	backendPid: number,
	logger: Logger,
): Promise<void> {
	const canceller = new SQL({
		...transaction.options,
		adapter: "postgres",
		max: 1,
		connectionTimeout: CANCEL_CONNECTION_TIMEOUT_S,
	});
	try {
		await canceller`SELECT pg_cancel_backend(${backendPid})`;
	} catch (error) {
		logger.error("statement not cancelled", { error: describeThrown(error) });
	} finally {
		await canceller.close();
	}
}
