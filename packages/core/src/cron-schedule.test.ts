import { describe, expect, test } from "bun:test";
import { type CronSchedule, readCronSchedule } from "./cron-schedule.ts";

function scheduleOf(expression: string): CronSchedule {
	const read = readCronSchedule(expression);
	if (!read.valid) throw new Error(read.problem);
	return read.schedule;
}

describe("a cron schedule", () => {
	test.each([
		[
			"every minute",
			"* * * * *",
			"2026-11-27T09:00:00.000Z",
			"2026-11-27T09:01:00.000Z",
		],
		[
			"the start of the next minute from within a minute",
			"* * * * *",
			"2026-11-27T09:00:30.500Z",
			"2026-11-27T09:01:00.000Z",
		],
		[
			"a step of minutes across the hour",
			"*/15 * * * *",
			"2026-11-27T09:46:00.000Z",
			"2026-11-27T10:00:00.000Z",
		],
		[
			"a step within a range of minutes",
			"10-50/20 * * * *",
			"2026-11-27T09:10:00.000Z",
			"2026-11-27T09:30:00.000Z",
		],
		[
			"a time of day on the next day once it has passed, in UTC",
			"30 2 * * *",
			"2026-11-27T09:00:00.000Z",
			"2026-11-28T02:30:00.000Z",
		],
		[
			"a day of the month in the next month",
			"0 0 1 * *",
			"2026-11-27T09:00:00.000Z",
			"2026-12-01T00:00:00.000Z",
		],
		[
			"a weekday after the weekend",
			"0 9 * * 1-5",
			"2026-11-27T09:00:00.000Z",
			"2026-11-30T09:00:00.000Z",
		],
		[
			"Sunday written as 7",
			"0 0 * * 7",
			"2026-11-27T09:00:00.000Z",
			"2026-11-29T00:00:00.000Z",
		],
		[
			"a day of the month or a day of the week when both are given",
			"0 0 13 * 5",
			"2026-11-27T00:00:00.000Z",
			"2026-12-04T00:00:00.000Z",
		],
		[
			"every day when the days of the month are a range that covers them all and a day of the week is given",
			"0 0 1-31 * 1",
			"2026-11-27T09:00:00.000Z",
			"2026-11-28T00:00:00.000Z",
		],
		[
			"a day of the week on a stepped day of the month when the day of the month starts with a star",
			"0 0 */2 * 1",
			"2026-11-27T09:00:00.000Z",
			"2026-12-07T00:00:00.000Z",
		],
		[
			"a day of the month on a stepped day of the week when the day of the week starts with a star",
			"0 0 13 * */2",
			"2026-11-27T09:00:00.000Z",
			"2026-12-13T00:00:00.000Z",
		],
		[
			"a leap day years ahead",
			"0 0 29 2 *",
			"2026-11-27T09:00:00.000Z",
			"2028-02-29T00:00:00.000Z",
		],
		[
			"lists of hours and months",
			"0,30 8-10 * 1,6 *",
			"2026-11-27T09:00:00.000Z",
			"2027-01-01T08:00:00.000Z",
		],
	])("falls due at %s", (_case, expression, after, expected) => {
		const schedule = scheduleOf(expression);

		expect(schedule.nextAfter(new Date(after))).toEqual(new Date(expected));
	});

	test.each([
		[
			"the start of the minute within a minute",
			"* * * * *",
			"2026-11-27T09:00:30.500Z",
			"2026-11-27T09:00:00.000Z",
		],
		[
			"the very time when it is due then",
			"*/5 * * * *",
			"2026-11-27T09:05:00.000Z",
			"2026-11-27T09:05:00.000Z",
		],
		[
			"a time of day on the day before while it has not come yet",
			"30 2 * * *",
			"2026-11-27T02:29:00.000Z",
			"2026-11-26T02:30:00.000Z",
		],
		[
			"a day of the month earlier in the month",
			"0 0 1 * *",
			"2026-11-27T09:00:00.000Z",
			"2026-11-01T00:00:00.000Z",
		],
		[
			"a weekday before the weekend",
			"0 9 * * 1-5",
			"2026-11-29T12:00:00.000Z",
			"2026-11-27T09:00:00.000Z",
		],
		[
			"a day of the month or a day of the week when both are given",
			"0 0 13 * 5",
			"2026-11-27T09:00:00.000Z",
			"2026-11-27T00:00:00.000Z",
		],
		[
			"the last minute of the year before",
			"59 23 31 12 *",
			"2026-11-27T09:00:00.000Z",
			"2025-12-31T23:59:00.000Z",
		],
		[
			"a leap day years back",
			"0 0 29 2 *",
			"2026-11-27T09:00:00.000Z",
			"2024-02-29T00:00:00.000Z",
		],
	])("was last due at %s", (_case, expression, upTo, expected) => {
		const schedule = scheduleOf(expression);

		expect(schedule.latestUpTo(new Date(upTo))).toEqual(new Date(expected));
	});

	test.each([
		[
			"that is not text",
			42,
			"must be a cron expression of five fields: minute, hour, day of month, month and day of week",
		],
		[
			"with four fields",
			"* * * *",
			"must be a cron expression of five fields: minute, hour, day of month, month and day of week",
		],
		[
			"with a minute beyond 59",
			"60 * * * *",
			'has the minute "60", which must be "*", a number, a range or a list of them within 0 to 59, each with an optional step',
		],
		[
			"with a step of zero",
			"*/0 * * * *",
			'has the minute "*/0", which must be "*", a number, a range or a list of them within 0 to 59, each with an optional step',
		],
		[
			"with a range that runs backwards",
			"0 17-9 * * *",
			'has the hour "17-9", which must be "*", a number, a range or a list of them within 0 to 23, each with an optional step',
		],
		[
			"with a name for a month",
			"0 0 1 JAN *",
			'has the month "JAN", which must be "*", a number, a range or a list of them within 1 to 12, each with an optional step',
		],
		[
			"with a day of the month of zero",
			"0 0 0 * *",
			'has the day of month "0", which must be "*", a number, a range or a list of them within 1 to 31, each with an optional step',
		],
		[
			"with a day of the week beyond 7",
			"0 0 * * 8",
			'has the day of week "8", which must be "*", a number, a range or a list of them within 0 to 7, each with an optional step',
		],
		["that never falls due", "0 0 31 2 *", "never falls due"],
	])("is rejected %s", (_case, expression, problem) => {
		expect(readCronSchedule(expression)).toEqual({ valid: false, problem });
	});
});
