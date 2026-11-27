import type { SetTimer } from "../hook-timeout.ts";

export type ManualTimer = {
	readonly setTimer: SetTimer;
	set(): Promise<void>;
	expire(): void;
};

export function manualTimer(): ManualTimer {
	let expire: (() => void) | undefined;
	let announce: (() => void) | undefined;
	return {
		setTimer: (onExpire) => {
			expire = onExpire;
			announce?.();
			return () => {
				expire = undefined;
			};
		},
		set: () =>
			new Promise<void>((resolve) => {
				announce = resolve;
			}),
		expire: () => {
			if (expire === undefined) throw new Error("no timer is pending");
			expire();
		},
	};
}
