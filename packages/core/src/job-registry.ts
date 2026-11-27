import { type EnqueuedJob, type JobContext, jobName } from "@workbench/sdk";
import { isRecord } from "./is-record.ts";
import { quote } from "./quote.ts";
import { type Validator, validatorOf } from "./schema-validation.ts";

export type RegisteredJob = {
	readonly plugin: string;
	readonly name: string;
	readonly maxAttempts: number;
	readonly validatePayload: Validator;
	run(job: EnqueuedJob<unknown>, ctx: JobContext): Promise<void>;
};

export type JobRegistry = {
	find(name: string): RegisteredJob | undefined;
	names(): readonly string[];
};

export type JobsRead = {
	readonly value: readonly RegisteredJob[];
	readonly problems: readonly string[];
};

const JOB_DEFINITION_NAME = /^[a-z][A-Za-z0-9]*$/;

const MOST_ATTEMPTS = 25;

export function readJobs(plugin: string, declared: unknown): JobsRead {
	if (declared === undefined) return { value: [], problems: [] };
	if (!Array.isArray(declared))
		return { value: [], problems: ["jobs must be a list of job definitions"] };
	const value: RegisteredJob[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const [position, candidate] of declared.entries()) {
		const read = readJob(plugin, position, candidate);
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

type JobRead =
	| { readonly valid: true; readonly job: RegisteredJob }
	| { readonly valid: false; readonly problem: string };

function readJob(
	plugin: string,
	position: number,
	candidate: unknown,
): JobRead {
	if (!isRecord(candidate))
		return invalid(`jobs[${position}] must be a job definition`);
	const { name, payload, maxAttempts, run } = candidate;
	if (typeof name !== "string" || !JOB_DEFINITION_NAME.test(name))
		return invalid(
			`jobs[${position}].name must be in camelCase, such as "sendReminder"`,
		);
	const fullName = jobName(plugin, { name });
	const validatePayload = validatorOf(payload);
	if (validatePayload === undefined)
		return invalid(
			`job ${quote(fullName)} must declare its payload as a schema`,
		);
	if (
		typeof maxAttempts !== "number" ||
		!Number.isInteger(maxAttempts) ||
		maxAttempts < 1 ||
		maxAttempts > MOST_ATTEMPTS
	)
		return invalid(
			`job ${quote(fullName)} must have maxAttempts that is an integer from 1 to ${MOST_ATTEMPTS}`,
		);
	if (typeof run !== "function")
		return invalid(`job ${quote(fullName)} must have a run function`);
	return {
		valid: true,
		job: {
			plugin,
			name: fullName,
			maxAttempts,
			validatePayload,
			run: async (job, ctx) => {
				await run.call(candidate, job, ctx);
			},
		},
	};
}

function invalid(problem: string): { valid: false; problem: string } {
	return { valid: false, problem };
}

export function registerJobs(jobs: readonly RegisteredJob[]): JobRegistry {
	const byName = new Map(jobs.map((job) => [job.name, job] as const));
	const names = [...byName.keys()];
	return {
		find: (name) => byName.get(name),
		names: () => names,
	};
}
