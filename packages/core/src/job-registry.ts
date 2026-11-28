import {
	type DueCronJob,
	type EnqueuedJob,
	type JobContext,
	jobName,
} from "@workbench/sdk";
import { type CronSchedule, readCronSchedule } from "./cron-schedule.ts";
import { isRecord } from "./is-record.ts";
import { type Owner, ownerName } from "./owner.ts";
import { quote } from "./quote.ts";
import { type Validator, validatorOf } from "./schema-validation.ts";

export type RegisteredEnqueuedJob = {
	readonly kind: "enqueued";
	readonly owner: Owner;
	readonly name: string;
	readonly maxAttempts: number;
	readonly validatePayload: Validator;
	run(job: EnqueuedJob<unknown>, ctx: JobContext): Promise<void>;
};

export type RegisteredCronJob = {
	readonly kind: "cron";
	readonly owner: Owner;
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

export class JobNotRegisteredError extends Error {
	constructor(job: string) {
		super(`no active plugin declares the job ${quote(job)}`);
		this.name = "JobNotRegisteredError";
	}
}

export function getJob(jobs: JobRegistry, name: string): RegisteredJob {
	const job = jobs.find(name);
	if (job === undefined) throw new JobNotRegisteredError(name);
	return job;
}

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

type JobListReader = {
	readonly name: string;
	readonly subject: string;
	readonly exampleName: string;
	read(
		common: CommonParts,
		candidate: Readonly<Record<string, unknown>>,
	): JobRead;
};

type CommonParts = Pick<RegisteredJob, "owner" | "name" | "maxAttempts"> & {
	run(job: unknown, ctx: JobContext): Promise<void>;
};

const ENQUEUED_JOBS: JobListReader = {
	name: "jobs",
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

const CRON_JOBS: JobListReader = {
	name: "cronJobs",
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

export function readJobs(owner: Owner, declared: DeclaredJobs): JobsRead {
	const value: RegisteredJob[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const read of [
		...readList(owner, declared.jobs, ENQUEUED_JOBS),
		...readList(owner, declared.cronJobs, CRON_JOBS),
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
	owner: Owner,
	declared: unknown,
	list: JobListReader,
): readonly JobRead[] {
	if (declared === undefined) return [];
	if (!Array.isArray(declared))
		return [
			invalid(`${list.name} must be a list of ${list.subject} definitions`),
		];
	return declared.map((candidate, position) =>
		readJob(owner, position, candidate, list),
	);
}

function readJob(
	owner: Owner,
	position: number,
	candidate: unknown,
	list: JobListReader,
): JobRead {
	if (!isRecord(candidate))
		return invalid(
			`${list.name}[${position}] must be a ${list.subject} definition`,
		);
	const { name, maxAttempts, run } = candidate;
	if (typeof name !== "string" || !JOB_DEFINITION_NAME.test(name))
		return invalid(
			`${list.name}[${position}].name must be in camelCase, such as ${quote(list.exampleName)}`,
		);
	const fullName = jobName(ownerName(owner), { name });
	if (
		typeof maxAttempts !== "number" ||
		!Number.isInteger(maxAttempts) ||
		maxAttempts < 1 ||
		maxAttempts > MOST_ATTEMPTS
	)
		return invalid(
			`${list.subject} ${quote(fullName)} must have maxAttempts that is an integer from 1 to ${MOST_ATTEMPTS}`,
		);
	if (typeof run !== "function")
		return invalid(
			`${list.subject} ${quote(fullName)} must have a run function`,
		);
	return list.read(
		{
			owner,
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
