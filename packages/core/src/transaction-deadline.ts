import { SQL } from "bun";
import { z } from "zod";
import { describeThrown } from "./failure-reason.ts";
import {
	type HookOutcome,
	type HookTimeout,
	runWithin,
	type SetTimer,
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

const CANCEL_AGAIN_AFTER_MS = 100;

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
	const inFlight = new Set<Promise<unknown>>();
	const outcome = await runWithin(
		(expired) =>
			hook({ sql: statementsUntil(expired, transaction, inFlight), expired }),
		timeout,
	);
	if (outcome === "timed_out")
		await cancelStatements(inFlight, {
			backendPid: pid,
			cancellation,
			setTimer: timeout.setTimer,
			logger,
		});
	return outcome;
}

function statementsUntil(
	expired: AbortSignal,
	transaction: SQL,
	inFlight: Set<Promise<unknown>>,
): TransactionStatements {
	return async (strings, ...values) => {
		if (expired.aborted) throw new StatementRefusedError();
		const statement: Promise<readonly unknown[]> = transaction(
			strings,
			...values,
		).execute();
		inFlight.add(statement);
		try {
			return await statement;
		} finally {
			inFlight.delete(statement);
		}
	};
}

type StatementCancellation = {
	readonly backendPid: number;
	readonly cancellation: SQL;
	readonly setTimer: SetTimer;
	readonly logger: Logger;
};

async function cancelStatements(
	inFlight: ReadonlySet<Promise<unknown>>,
	{ backendPid, cancellation, setTimer, logger }: StatementCancellation,
): Promise<void> {
	while (inFlight.size > 0) {
		try {
			await cancellation`SELECT pg_cancel_backend(${backendPid})`;
		} catch (error) {
			logger.error("statement not cancelled", { error: describeThrown(error) });
			return;
		}
		await runWithin(
			async () => {
				await Promise.allSettled(inFlight);
			},
			{ ms: CANCEL_AGAIN_AFTER_MS, setTimer },
		);
	}
}
