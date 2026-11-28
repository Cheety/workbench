import { removeExpiredIdempotencyKeys } from "./idempotency-keys.ts";
import { type RegisteredJob, readJobs } from "./job-registry.ts";
import { CORE_OWNER } from "./owner.ts";

export class InvalidCoreJobsError extends Error {
	constructor(problems: readonly string[]) {
		super(`the jobs of the core are invalid: ${problems.join("; ")}`);
		this.name = "InvalidCoreJobsError";
	}
}

function readCoreJobs(): readonly RegisteredJob[] {
	const { value, problems } = readJobs(CORE_OWNER, {
		jobs: undefined,
		cronJobs: [removeExpiredIdempotencyKeys],
	});
	if (problems.length > 0) throw new InvalidCoreJobsError(problems);
	return value;
}

export const CORE_JOBS: readonly RegisteredJob[] = readCoreJobs();
