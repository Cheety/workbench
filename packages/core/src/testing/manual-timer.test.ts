import { describe, expect, test } from "bun:test";
import { manualTimer } from "./manual-timer.ts";

describe("a manual timer", () => {
	test("expires the pending timer of the shortest delay, as a clock running forward would", () => {
		const timer = manualTimer();
		const expired: string[] = [];
		timer.setTimer(() => expired.push("short"), 100);
		timer.setTimer(() => expired.push("long"), 250);

		timer.expire();

		expect(expired).toEqual(["short"]);
	});

	test("expires the timer whose deadline comes first, counting each delay from the time its timer was set", () => {
		const timer = manualTimer();
		const expired: string[] = [];
		timer.setTimer(() => expired.push("set first"), 300);
		timer.setTimer(() => {}, 100);
		timer.expire();
		timer.setTimer(() => expired.push("set later"), 250);

		timer.expire();

		expect(expired).toEqual(["set first"]);
	});

	test("expires the timer set first among timers of the same deadline", () => {
		const timer = manualTimer();
		const expired: string[] = [];
		timer.setTimer(() => expired.push("first"), 100);
		timer.setTimer(() => expired.push("second"), 100);

		timer.expire();

		expect(expired).toEqual(["first"]);
	});

	test("no longer counts a timer once it expired or was cancelled", () => {
		const timer = manualTimer();
		timer.setTimer(() => {}, 100);
		const cancel = timer.setTimer(() => {}, 250);
		timer.setTimer(() => {}, 400);

		timer.expire();
		cancel();

		expect(timer.pendingCount()).toBe(1);
	});
});
