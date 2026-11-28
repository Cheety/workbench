export type SetTimer = (expire: () => void, delayMs: number) => () => void;

export type HookTimeout = {
	readonly ms: number;
	readonly setTimer: SetTimer;
};

export type HookOutcome = "finished" | "timed_out";

export const setSystemTimer: SetTimer = (expire, delayMs) => {
	const timer = setTimeout(expire, delayMs);
	return () => clearTimeout(timer);
};

export type Hook = (expired: AbortSignal) => Promise<void>;

export function runWithin(
	hook: Hook,
	timeout: HookTimeout,
): Promise<HookOutcome> {
	return new Promise((resolve, reject) => {
		const expiry = new AbortController();
		const cancel = timeout.setTimer(() => {
			expiry.abort();
			resolve("timed_out");
		}, timeout.ms);
		const fail = (error: unknown) => {
			cancel();
			reject(error);
		};
		try {
			hook(expiry.signal).then(() => {
				cancel();
				resolve("finished");
			}, fail);
		} catch (error) {
			fail(error);
		}
	});
}
