import type { SetTimer } from "../hook-timeout.ts";

export type ManualTimer = {
	readonly setTimer: SetTimer;
	readonly delaysMs: readonly number[];
	isPending(): boolean;
	pendingCount(): number;
	set(): Promise<void>;
	expire(): void;
};

export function manualTimer(): ManualTimer {
	const delaysMs: number[] = [];
	const pending: { readonly expire: () => void }[] = [];
	let announce: (() => void) | undefined;
	return {
		setTimer: (expire, delayMs) => {
			delaysMs.push(delayMs);
			const timer = { expire };
			pending.push(timer);
			announce?.();
			announce = undefined;
			return () => {
				const index = pending.indexOf(timer);
				if (index !== -1) pending.splice(index, 1);
			};
		},
		delaysMs,
		isPending: () => pending.length > 0,
		pendingCount: () => pending.length,
		set: () =>
			new Promise<void>((resolve) => {
				announce = resolve;
			}),
		expire: () => {
			const latest = pending.pop();
			if (latest === undefined) throw new Error("no timer is pending");
			latest.expire();
		},
	};
}
