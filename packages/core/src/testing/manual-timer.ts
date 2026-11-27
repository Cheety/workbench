import type { SetTimer } from "../hook-timeout.ts";

export type ManualTimer = {
	readonly setTimer: SetTimer;
	readonly delaysMs: readonly number[];
	isPending(): boolean;
	set(): Promise<void>;
	expire(): void;
};

export function manualTimer(): ManualTimer {
	const delaysMs: number[] = [];
	let pending: (() => void) | undefined;
	let announce: (() => void) | undefined;
	return {
		setTimer: (expire, delayMs) => {
			delaysMs.push(delayMs);
			pending = expire;
			announce?.();
			announce = undefined;
			return () => {
				if (pending === expire) pending = undefined;
			};
		},
		delaysMs,
		isPending: () => pending !== undefined,
		set: () =>
			new Promise<void>((resolve) => {
				announce = resolve;
			}),
		expire: () => {
			if (pending === undefined) throw new Error("no timer is pending");
			const expire = pending;
			pending = undefined;
			expire();
		},
	};
}
