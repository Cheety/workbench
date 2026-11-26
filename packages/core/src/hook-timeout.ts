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
