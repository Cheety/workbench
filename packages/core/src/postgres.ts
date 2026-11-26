import { SQL } from "bun";
import type { Secret } from "./config.ts";
import { UNKNOWN_FAILURE_REASON } from "./failure-reason.ts";
import type { Logger } from "./logger.ts";

export type DatabaseStatus =
	| { readonly reachable: true }
	| { readonly reachable: false; readonly reason: string };

export type DatabaseCheck = () => Promise<DatabaseStatus>;

const TIMEOUT_REASON = "timeout";

export type PostgresCheckOptions = {
	readonly url: Secret;
	readonly timeoutMs: number;
	readonly logger: Logger;
};

export function createPostgresCheck(
	options: PostgresCheckOptions,
): DatabaseCheck {
	let inFlight: Promise<DatabaseStatus> | undefined;
	return () => {
		inFlight ??= queryOnce(options).finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	};
}

async function queryOnce(
	options: PostgresCheckOptions,
): Promise<DatabaseStatus> {
	const sql = new SQL(options.url.reveal(), {
		max: 1,
		connectionTimeout: options.timeoutMs / 1000,
	});
	const answered = sql`SELECT 1`.then(
		(): DatabaseStatus => ({ reachable: true }),
		(error: unknown): DatabaseStatus => ({
			reachable: false,
			reason: describeFailure(error),
		}),
	);
	const { promise: timedOut, resolve } =
		Promise.withResolvers<DatabaseStatus>();
	const timer = setTimeout(
		() => resolve({ reachable: false, reason: TIMEOUT_REASON }),
		options.timeoutMs,
	);
	try {
		return await Promise.race([answered, timedOut]);
	} finally {
		clearTimeout(timer);
		await sql.close({ timeout: 0 }).catch((error: unknown) => {
			options.logger.warn("closing the readiness connection failed", {
				reason: describeFailure(error),
			});
		});
	}
}

function describeFailure(error: unknown): string {
	if (!(error instanceof SQL.PostgresError)) return UNKNOWN_FAILURE_REASON;
	return error.errno ?? error.code;
}
