import {
	type DueCronJob,
	type EnqueuedJob,
	type JobContext,
	jobName,
} from "@workbench/sdk";
import { type CronSchedule, readCronSchedule } from "./cron-schedule.ts";
import { isRecord } from "./is-record.ts";
import { quote } from "./quote.ts";
import { type Validator, validatorOf } from "./schema-validation.ts";

export type RegisteredEnqueuedJob = {
	readonly kind: "enqueued";
	readonly plugin: string;
	readonly name: string;
	readonly maxAttempts: number;
	readonly validatePayload: Validator;
	run(job: EnqueuedJob<unknown>, ctx: JobContext): Promise<void>;
};

export type RegisteredCronJob = {
	readonly kind: "cron";
	readonly plugin: string;
	readonly name: string;
	readonly maxAttempts: number;
	readonly schedule: CronSchedule;
	run(job: DueCronJob, ctx: JobContext): Promise<void>;
};

export type RegisteredJob = RegisteredEnqueuedJob | RegisteredCronJob;

export type JobRegistry = {
	find(name: string): RegisteredJob | undefined;
	names(): readonly string[];
	cronJobs(): readonly RegisteredCronJob[];
};

export type JobsRead = {
	readonly value: readonly RegisteredJob[];
	readonly problems: readonly string[];
};

export type DeclaredJobs = {
	readonly jobs: unknown;
	readonly cronJobs: unknown;
};

const JOB_DEFINITION_NAME = /^[a-z][A-Za-z0-9]*$/;

const MOST_ATTEMPTS = 25;

type JobRead =
	| { readonly valid: true; readonly job: RegisteredJob }
	| { readonly valid: false; readonly problem: string };

type JobKind = {
	readonly list: string;
	readonly subject: string;
	readonly exampleName: string;
	read(
		common: CommonParts,
		candidate: Readonly<Record<string, unknown>>,
	): JobRead;
};

type CommonParts = Pick<RegisteredJob, "plugin" | "name" | "maxAttempts"> & {
	run(job: unknown, ctx: JobContext): Promise<void>;
};

const ENQUEUED: JobKind = {
	list: "jobs",
	subject: "job",
	exampleName: "sendReminder",
	read: (common, candidate) => {
		const validatePayload = validatorOf(candidate.payload);
		if (validatePayload === undefined)
			return invalid(
				`job ${quote(common.name)} must declare its payload as a schema`,
			);
		return {
			valid: true,
			job: {
				kind: "enqueued",
				...common,
				validatePayload,
			},
		};
	},
};

const CRON: JobKind = {
	list: "cronJobs",
	subject: "cron job",
	exampleName: "sendDigest",
	read: (common, candidate) => {
		const schedule = readCronSchedule(candidate.schedule);
		if (!schedule.valid)
			return invalid(
				`the schedule of cron job ${quote(common.name)} ${schedule.problem}`,
			);
		return {
			valid: true,
			job: {
				kind: "cron",
				...common,
				schedule: schedule.schedule,
			},
		};
	},
};

export function readJobs(plugin: string, declared: DeclaredJobs): JobsRead {
	const value: RegisteredJob[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const read of [
		...readList(plugin, declared.jobs, ENQUEUED),
		...readList(plugin, declared.cronJobs, CRON),
	]) {
		if (!read.valid) {
			problems.push(read.problem);
			continue;
		}
		if (seen.has(read.job.name)) {
			problems.push(`job ${quote(read.job.name)} is declared more than once`);
			continue;
		}
		seen.add(read.job.name);
		value.push(read.job);
	}
	return { value, problems };
}

function readList(
	plugin: string,
	declared: unknown,
	kind: JobKind,
): readonly JobRead[] {
	if (declared === undefined) return [];
	if (!Array.isArray(declared))
		return [
			invalid(`${kind.list} must be a list of ${kind.subject} definitions`),
		];
	return declared.map((candidate, position) =>
		readJob(plugin, position, candidate, kind),
	);
}

function readJob(
	plugin: string,
	position: number,
	candidate: unknown,
	kind: JobKind,
): JobRead {
	if (!isRecord(candidate))
		return invalid(
			`${kind.list}[${position}] must be a ${kind.subject} definition`,
		);
	const { name, maxAttempts, run } = candidate;
	if (typeof name !== "string" || !JOB_DEFINITION_NAME.test(name))
		return invalid(
			`${kind.list}[${position}].name must be in camelCase, such as ${quote(kind.exampleName)}`,
		);
	const fullName = jobName(plugin, { name });
	if (
		typeof maxAttempts !== "number" ||
		!Number.isInteger(maxAttempts) ||
		maxAttempts < 1 ||
		maxAttempts > MOST_ATTEMPTS
	)
		return invalid(
			`${kind.subject} ${quote(fullName)} must have maxAttempts that is an integer from 1 to ${MOST_ATTEMPTS}`,
		);
	if (typeof run !== "function")
		return invalid(
			`${kind.subject} ${quote(fullName)} must have a run function`,
		);
	return kind.read(
		{
			plugin,
			name: fullName,
			maxAttempts,
			run: async (job, ctx) => {
				await run.call(candidate, job, ctx);
			},
		},
		candidate,
	);
}

function invalid(problem: string): { valid: false; problem: string } {
	return { valid: false, problem };
}

export function registerJobs(jobs: readonly RegisteredJob[]): JobRegistry {
	const byName = new Map(jobs.map((job) => [job.name, job] as const));
	const names = [...byName.keys()];
	const cronJobs = jobs.filter((job) => job.kind === "cron");
	return {
		find: (name) => byName.get(name),
		names: () => names,
		cronJobs: () => cronJobs,
	};
}
