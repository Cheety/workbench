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
import { statementsIn } from "./transaction-statements.ts";

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

const STATEMENT_TIMEOUT_GRACE_MS = 1000;

const backend = z.object({
	pid: z.number().int(),
	statement_timeout_ms: z.coerce.number().int().nonnegative(),
});

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
	const [row]: unknown[] = await transaction`
		SELECT pg_backend_pid() AS pid, setting AS statement_timeout_ms
		FROM pg_settings WHERE name = 'statement_timeout'`;
	const { pid, statement_timeout_ms } = backend.parse(row);
	await limitStatements(
		transaction,
		statementTimeoutWithin(timeout.ms, statement_timeout_ms),
	);
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
	else await limitStatements(transaction, statement_timeout_ms);
	return outcome;
}

function statementTimeoutWithin(
	hookTimeoutMs: number,
	statementTimeoutMs: number,
): number {
	const hookLimitMs = hookTimeoutMs + STATEMENT_TIMEOUT_GRACE_MS;
	return statementTimeoutMs === 0
		? hookLimitMs
		: Math.min(hookLimitMs, statementTimeoutMs);
}

async function limitStatements(transaction: SQL, ms: number): Promise<void> {
	await transaction`SELECT set_config('statement_timeout', ${String(ms)}, true)`;
}

function statementsUntil(
	expired: AbortSignal,
	transaction: SQL,
	inFlight: Set<Promise<unknown>>,
): TransactionStatements {
	const statements = statementsIn(transaction);
	return async (strings, ...values) => {
		if (expired.aborted) throw new StatementRefusedError();
		const statement = statements(strings, ...values);
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
