import { quote } from "./quote.ts";

export type CronSchedule = {
	nextAfter(time: Date): Date;
};

export type CronScheduleRead =
	| { readonly valid: true; readonly schedule: CronSchedule }
	| { readonly valid: false; readonly problem: string };

export class CronScheduleNeverDueError extends Error {
	constructor(expression: string) {
		super(`the cron schedule ${quote(expression)} never falls due`);
		this.name = "CronScheduleNeverDueError";
	}
}

type FieldRange = {
	readonly label: string;
	readonly min: number;
	readonly max: number;
};

const MINUTE: FieldRange = { label: "minute", min: 0, max: 59 };
const HOUR: FieldRange = { label: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldRange = { label: "day of month", min: 1, max: 31 };
const MONTH: FieldRange = { label: "month", min: 1, max: 12 };
const DAY_OF_WEEK: FieldRange = { label: "day of week", min: 0, max: 7 };

const SUNDAY = 0;
const SUNDAY_AS_SEVEN = 7;
const DAYS_OF_A_WEEK = 7;

const FIELD_ITEM = /^(?:\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/;

const MINUTE_MS = 60_000;

const SEARCH_HORIZON_MS = 10 * 366 * 24 * 60 * MINUTE_MS;

const WHITESPACE = /\s+/;

type Fields = {
	readonly minutes: ReadonlySet<number>;
	readonly hours: ReadonlySet<number>;
	readonly daysOfMonth: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	readonly daysOfWeek: ReadonlySet<number>;
};

export function readCronSchedule(expression: unknown): CronScheduleRead {
	const texts =
		typeof expression === "string" ? expression.trim().split(WHITESPACE) : [];
	const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = texts;
	if (
		typeof expression !== "string" ||
		minute === undefined ||
		hour === undefined ||
		dayOfMonth === undefined ||
		month === undefined ||
		dayOfWeek === undefined ||
		rest.length > 0
	)
		return invalid(
			"must be a cron expression of five fields: minute, hour, day of month, month and day of week",
		);
	const minutes = readField(minute, MINUTE);
	if (minutes === undefined) return invalidField(minute, MINUTE);
	const hours = readField(hour, HOUR);
	if (hours === undefined) return invalidField(hour, HOUR);
	const daysOfMonth = readField(dayOfMonth, DAY_OF_MONTH);
	if (daysOfMonth === undefined) return invalidField(dayOfMonth, DAY_OF_MONTH);
	const months = readField(month, MONTH);
	if (months === undefined) return invalidField(month, MONTH);
	const daysOfWeek = readField(dayOfWeek, DAY_OF_WEEK);
	if (daysOfWeek === undefined) return invalidField(dayOfWeek, DAY_OF_WEEK);
	const fields: Fields = {
		minutes,
		hours,
		daysOfMonth,
		months,
		daysOfWeek: new Set(
			[...daysOfWeek].map((day) => (day === SUNDAY_AS_SEVEN ? SUNDAY : day)),
		),
	};
	if (findNextAfter(fields, new Date(0)) === undefined)
		return invalid("never falls due");
	return {
		valid: true,
		schedule: {
			nextAfter: (time) => {
				const next = findNextAfter(fields, time);
				if (next === undefined) throw new CronScheduleNeverDueError(expression);
				return next;
			},
		},
	};
}

function invalid(problem: string): CronScheduleRead {
	return { valid: false, problem };
}

function invalidField(text: string, { label, min, max }: FieldRange) {
	return invalid(
		`has the ${label} ${quote(text)}, which must be "*", a number, a range or a list of them within ${min} to ${max}, each with an optional step`,
	);
}

function readField(
	text: string,
	range: FieldRange,
): ReadonlySet<number> | undefined {
	const values = new Set<number>();
	for (const item of text.split(",")) {
		const itemValues = readItem(item, range);
		if (itemValues === undefined) return undefined;
		for (const value of itemValues) values.add(value);
	}
	return values;
}

function readItem(
	item: string,
	{ min, max }: FieldRange,
): readonly number[] | undefined {
	const match = FIELD_ITEM.exec(item);
	if (match === null) return undefined;
	const [, first, last, stepText] = match;
	const from = first === undefined ? min : Number(first);
	const to =
		last !== undefined
			? Number(last)
			: first === undefined || stepText !== undefined
				? max
				: from;
	const step = stepText === undefined ? 1 : Number(stepText);
	if (from < min || to > max || from > to || step < 1) return undefined;
	const values: number[] = [];
	for (let value = from; value <= to; value += step) values.push(value);
	return values;
}

function findNextAfter(fields: Fields, time: Date): Date | undefined {
	const start = Math.floor(time.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
	const horizon = start + SEARCH_HORIZON_MS;
	let candidate = start;
	while (candidate <= horizon) {
		const at = new Date(candidate);
		const year = at.getUTCFullYear();
		const month = at.getUTCMonth();
		const day = at.getUTCDate();
		const hour = at.getUTCHours();
		if (!fields.months.has(month + 1)) candidate = Date.UTC(year, month + 1, 1);
		else if (!isDueOnDay(fields, at))
			candidate = Date.UTC(year, month, day + 1);
		else if (!fields.hours.has(hour))
			candidate = Date.UTC(year, month, day, hour + 1);
		else if (!fields.minutes.has(at.getUTCMinutes())) candidate += MINUTE_MS;
		else return at;
	}
	return undefined;
}

function isDueOnDay(fields: Fields, at: Date): boolean {
	const onDayOfMonth = fields.daysOfMonth.has(at.getUTCDate());
	const onDayOfWeek = fields.daysOfWeek.has(at.getUTCDay());
	const isAnyDayOfMonth =
		fields.daysOfMonth.size === DAY_OF_MONTH.max - DAY_OF_MONTH.min + 1;
	const isAnyDayOfWeek = fields.daysOfWeek.size === DAYS_OF_A_WEEK;
	if (isAnyDayOfMonth || isAnyDayOfWeek) return onDayOfMonth && onDayOfWeek;
	return onDayOfMonth || onDayOfWeek;
}
