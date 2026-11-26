/** Calls `expire` after `delayMs`; the returned function cancels that. */
export type SetTimer = (expire: () => void, delayMs: number) => () => void;

/** How long one plugin may take to load its entry, to activate, and to deactivate. */
export type HookTimeout = {
	readonly ms: number;
	readonly setTimer: SetTimer;
};

export type HookOutcome = "finished" | "timed_out";

export const setSystemTimer: SetTimer = (expire, delayMs) => {
	const timer = setTimeout(expire, delayMs);
	return () => clearTimeout(timer);
};

/**
 * Waits for a plugin hook or entry, but no longer than the timeout. A hook that timed
 * out keeps running, since nothing can stop it; what it does afterwards,
 * failing included, is ignored.
 *
 * Rejects with what the hook threw if it fails in time.
 */
export function runWithin(
	hook: () => Promise<void>,
	timeout: HookTimeout,
): Promise<HookOutcome> {
	return new Promise((resolve, reject) => {
		const cancel = timeout.setTimer(() => resolve("timed_out"), timeout.ms);
		const fail = (error: unknown) => {
			cancel();
			reject(error);
		};
		try {
			hook().then(() => {
				cancel();
				resolve("finished");
			}, fail);
		} catch (error) {
			fail(error);
		}
	});
}
