import { quote } from "./quote.ts";

export type CronSchedule = {
	nextAfter(time: Date): Date;
	latestUpTo(time: Date): Date;
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

const ANY = "*";

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
	readonly isAnyDayOfMonth: boolean;
	readonly isAnyDayOfWeek: boolean;
};

const FIVE_FIELDS =
	"must be a cron expression of five fields: minute, hour, day of month, month and day of week";

class UnreadableFieldError extends Error {
	readonly problem: string;

	constructor(text: string, { label, min, max }: FieldRange) {
		const problem = `has the ${label} ${quote(text)}, which must be "*", a number, a range or a list of them within ${min} to ${max}, each with an optional step`;
		super(problem);
		this.name = "UnreadableFieldError";
		this.problem = problem;
	}
}

export function readCronSchedule(expression: unknown): CronScheduleRead {
	if (typeof expression !== "string") return invalid(FIVE_FIELDS);
	const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression
		.trim()
		.split(WHITESPACE);
	if (
		minute === undefined ||
		hour === undefined ||
		dayOfMonth === undefined ||
		month === undefined ||
		dayOfWeek === undefined ||
		rest.length > 0
	)
		return invalid(FIVE_FIELDS);
	try {
		return scheduleOf(expression, {
			minutes: readField(minute, MINUTE),
			hours: readField(hour, HOUR),
			daysOfMonth: readField(dayOfMonth, DAY_OF_MONTH),
			months: readField(month, MONTH),
			daysOfWeek: new Set(
				[...readField(dayOfWeek, DAY_OF_WEEK)].map((day) =>
					day === SUNDAY_AS_SEVEN ? SUNDAY : day,
				),
			),
			isAnyDayOfMonth: dayOfMonth.startsWith(ANY),
			isAnyDayOfWeek: dayOfWeek.startsWith(ANY),
		});
	} catch (error) {
		if (error instanceof UnreadableFieldError) return invalid(error.problem);
		throw error;
	}
}

function scheduleOf(expression: string, fields: Fields): CronScheduleRead {
	if (findDue(fields, new Date(0), FORWARD) === undefined)
		return invalid("never falls due");
	const found = (due: Date | undefined): Date => {
		if (due === undefined) throw new CronScheduleNeverDueError(expression);
		return due;
	};
	return {
		valid: true,
		schedule: {
			nextAfter: (time) => found(findDue(fields, time, FORWARD)),
			latestUpTo: (time) => found(findDue(fields, time, BACKWARD)),
		},
	};
}

function invalid(problem: string): CronScheduleRead {
	return { valid: false, problem };
}

function readField(text: string, range: FieldRange): ReadonlySet<number> {
	const values = new Set<number>();
	for (const item of text.split(",")) {
		const itemValues = readItem(item, range);
		if (itemValues === undefined) throw new UnreadableFieldError(text, range);
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

type SearchDirection = {
	first(minute: number): number;
	isWithinHorizon(candidate: number, first: number): boolean;
	pastMonth(at: Date): number;
	pastDay(at: Date): number;
	pastHour(at: Date): number;
	pastMinute(at: Date): number;
};

const FORWARD: SearchDirection = {
	first: (minute) => minute + MINUTE_MS,
	isWithinHorizon: (candidate, first) => candidate <= first + SEARCH_HORIZON_MS,
	pastMonth: (at) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1),
	pastDay: (at) =>
		Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1),
	pastHour: (at) =>
		Date.UTC(
			at.getUTCFullYear(),
			at.getUTCMonth(),
			at.getUTCDate(),
			at.getUTCHours() + 1,
		),
	pastMinute: (at) => at.getTime() + MINUTE_MS,
};

const BACKWARD: SearchDirection = {
	first: (minute) => minute,
	isWithinHorizon: (candidate, first) => candidate >= first - SEARCH_HORIZON_MS,
	pastMonth: (at) =>
		Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) - MINUTE_MS,
	pastDay: (at) =>
		Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) -
		MINUTE_MS,
	pastHour: (at) =>
		Date.UTC(
			at.getUTCFullYear(),
			at.getUTCMonth(),
			at.getUTCDate(),
			at.getUTCHours(),
		) - MINUTE_MS,
	pastMinute: (at) => at.getTime() - MINUTE_MS,
};

function findDue(
	fields: Fields,
	time: Date,
	direction: SearchDirection,
): Date | undefined {
	const first = direction.first(
		Math.floor(time.getTime() / MINUTE_MS) * MINUTE_MS,
	);
	let candidate = first;
	while (direction.isWithinHorizon(candidate, first)) {
		const at = new Date(candidate);
		if (!fields.months.has(at.getUTCMonth() + 1))
			candidate = direction.pastMonth(at);
		else if (!isDueOnDay(fields, at)) candidate = direction.pastDay(at);
		else if (!fields.hours.has(at.getUTCHours()))
			candidate = direction.pastHour(at);
		else if (!fields.minutes.has(at.getUTCMinutes()))
			candidate = direction.pastMinute(at);
		else return at;
	}
	return undefined;
}

function isDueOnDay(fields: Fields, at: Date): boolean {
	const onDayOfMonth = fields.daysOfMonth.has(at.getUTCDate());
	const onDayOfWeek = fields.daysOfWeek.has(at.getUTCDay());
	if (fields.isAnyDayOfMonth || fields.isAnyDayOfWeek)
		return onDayOfMonth && onDayOfWeek;
	return onDayOfMonth || onDayOfWeek;
}
