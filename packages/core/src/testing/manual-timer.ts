import type { SetTimer } from "../hook-timeout.ts";

export type ManualTimer = {
	readonly setTimer: SetTimer;
	readonly delaysMs: readonly number[];
	isPending(): boolean;
	pendingCount(): number;
	set(): Promise<void>;
	expire(): void;
};

type PendingTimer = {
	readonly expire: () => void;
	readonly deadlineMs: number;
};

export function manualTimer(): ManualTimer {
	const delaysMs: number[] = [];
	const pending: PendingTimer[] = [];
	let nowMs = 0;
	let announce: (() => void) | undefined;
	return {
		setTimer: (expire, delayMs) => {
			delaysMs.push(delayMs);
			const timer = { expire, deadlineMs: nowMs + delayMs };
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
			const soonest = pending.reduce<PendingTimer | undefined>(
				(found, timer) =>
					found === undefined || timer.deadlineMs < found.deadlineMs
						? timer
						: found,
				undefined,
			);
			if (soonest === undefined) throw new Error("no timer is pending");
			pending.splice(pending.indexOf(soonest), 1);
			nowMs = soonest.deadlineMs;
			soonest.expire();
		},
	};
}
