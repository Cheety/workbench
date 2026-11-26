import { SQL } from "bun";
import type { Secret } from "./config.ts";

/** `reason` is a short machine-readable cause, e.g. `timeout` or a driver error code. */
export type DatabaseStatus =
	| { readonly reachable: true }
	| { readonly reachable: false; readonly reason: string };

/** Never rejects: an unreachable database is a status, not an error. */
export type DatabaseCheck = () => Promise<DatabaseStatus>;

const TIMEOUT_REASON = "timeout";
const UNKNOWN_REASON = "unknown";

/**
 * Creates a check that reports whether Postgres answers a query within
 * `timeoutMs` milliseconds.
 *
 * Calls that overlap share one check and its result, so the check never
 * holds more than one connection, however many callers ask at once.
 */
export function createPostgresCheck(options: {
	readonly url: Secret;
	readonly timeoutMs: number;
}): DatabaseCheck {
	let inFlight: Promise<DatabaseStatus> | undefined;
	return () => {
		inFlight ??= queryOnce(options).finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	};
}

async function queryOnce(options: {
	readonly url: Secret;
	readonly timeoutMs: number;
}): Promise<DatabaseStatus> {
	// A connection of its own per check: a pooled connection that hangs
	// would keep later checks waiting behind it after Postgres is back.
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
	// The driver's own timeout covers connecting only and overshoots while
	// it retries, so the deadline is enforced here.
	const timer = setTimeout(
		() => resolve({ reachable: false, reason: TIMEOUT_REASON }),
		options.timeoutMs,
	);
	try {
		return await Promise.race([answered, timedOut]);
	} finally {
		clearTimeout(timer);
		// Awaited so that the next check starts only after this connection
		// is gone; without a grace period it does not wait for a hung query.
		await sql.close({ timeout: 0 }).catch(() => {});
	}
}

// Only codes are reported: driver messages are not guaranteed to be free of
// connection details. The SQLSTATE sent by the server is the more specific one.
function describeFailure(error: unknown): string {
	if (!(error instanceof SQL.PostgresError)) return UNKNOWN_REASON;
	return error.errno ?? error.code;
}
