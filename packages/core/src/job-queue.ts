import {
	type EnqueuedJob,
	type JobContext,
	type JobDefinition,
	jobName,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { fullJitterBackoff } from "./database-wait.ts";
import { describeThrown, type ThrownError } from "./failure-reason.ts";
import { type HookTimeout, runWithin } from "./hook-timeout.ts";
import type { JobRegistry, RegisteredJob } from "./job-registry.ts";
import type { Logger } from "./logger.ts";
import { quote } from "./quote.ts";
import { pluginSchemaName } from "./schema-name.ts";
import type { ValidationIssue } from "./schema-validation.ts";

export class UndeclaredJobError extends Error {
	constructor(plugin: string, job: string) {
		super(
			`${quote(plugin)} enqueued the job ${quote(job)}, which it does not declare among its jobs`,
		);
		this.name = "UndeclaredJobError";
	}
}

export class InvalidJobPayloadError extends Error {
	readonly issues: readonly ValidationIssue[];

	constructor(job: string, issues: readonly ValidationIssue[]) {
		super(
			`the payload of the job ${quote(job)} does not match its payload schema`,
		);
		this.name = "InvalidJobPayloadError";
		this.issues = issues;
	}
}

export type JobEnqueueing = {
	readonly id: string;
	readonly plugin: string;
	readonly definition: JobDefinition<unknown>;
	readonly payload: unknown;
	readonly enqueuedAt: Date;
	readonly workspace: string;
};

export async function enqueueJob(
	transaction: SQL,
	jobs: JobRegistry,
	enqueueing: JobEnqueueing,
): Promise<void> {
	const name = jobName(enqueueing.plugin, enqueueing.definition);
	const job = jobs.find(name);
	if (job === undefined) throw new UndeclaredJobError(enqueueing.plugin, name);
	const payload = await job.validatePayload(enqueueing.payload);
	if (!payload.valid) throw new InvalidJobPayloadError(name, payload.issues);
	await transaction`
		INSERT INTO core.jobs (id, name, payload, workspace_id, enqueued_at, next_attempt_at)
		VALUES (${enqueueing.id}, ${name}, ${payload.value}, ${enqueueing.workspace}, ${enqueueing.enqueuedAt}, ${enqueueing.enqueuedAt})`;
}

export type JobQueueOptions = {
	readonly sql: SQL;
	readonly jobs: JobRegistry;
	readonly now: () => Date;
	readonly newId: () => string;
	readonly random: () => number;
	readonly runTimeout: HookTimeout;
	readonly logger: Logger;
};

export type JobQueue = {
	runDue(stopSignal: AbortSignal): Promise<void>;
};

const REDELIVERY_BUFFER_MS = 60_000;

const RETRY = { baseMs: 5_000, capMs: 3_600_000 } as const;

const SHORTEST_RETRY_MS = 1;

const claimedJob = z.object({
	id: z.string(),
	name: z.string(),
	payload: z.unknown(),
	workspace_id: z.string(),
	enqueued_at: z.date(),
	attempts: z.number(),
});

type ClaimedJob = z.infer<typeof claimedJob>;

type JobFailure =
	| { readonly reason: "run_threw"; readonly error: ThrownError }
	| { readonly reason: "run_timed_out"; readonly timeoutMs: number }
	| {
			readonly reason: "invalid_payload";
			readonly issues: readonly ValidationIssue[];
	  }
	| { readonly reason: "attempt_failed"; readonly error: ThrownError };

const IS_RETRIED: Record<JobFailure["reason"], boolean> = {
	run_threw: true,
	run_timed_out: true,
	invalid_payload: false,
	attempt_failed: true,
};

type Attempt =
	| { readonly outcome: "completed" }
	| {
			readonly outcome: "postponed";
			readonly failure: JobFailure;
			readonly retryInMs: number;
	  }
	| { readonly outcome: "dead_lettered"; readonly failure: JobFailure }
	| { readonly outcome: "settled_elsewhere" };

const SETTLED_ELSEWHERE: Attempt = { outcome: "settled_elsewhere" };

class SettledElsewhereError extends Error {
	constructor() {
		super("another attempt settled the job before this one completed it");
		this.name = "SettledElsewhereError";
	}
}

class JobFailedError extends Error {
	readonly failure: JobFailure;

	constructor(failure: JobFailure) {
		super(`the job did not complete (${failure.reason})`);
		this.name = "JobFailedError";
		this.failure = failure;
	}
}

type AttemptOptions = JobQueueOptions & {
	readonly retryDelayMs: (attempt: number) => number;
};

export function createJobQueue(options: JobQueueOptions): JobQueue {
	const attemptOptions: AttemptOptions = {
		...options,
		retryDelayMs: fullJitterBackoff({ ...RETRY, random: options.random }),
	};
	return {
		runDue: async (stopSignal) => {
			if (options.jobs.names().length === 0) return;
			const dueBy = options.now();
			while (!stopSignal.aborted) {
				const claimed = await claimNext(options, dueBy);
				if (claimed === undefined) return;
				const job = options.jobs.find(claimed.name);
				if (job === undefined) continue;
				report(claimed, await attempt(claimed, job, attemptOptions), options);
			}
		},
	};
}

async function claimNext(
	{
		sql,
		jobs,
		now,
		runTimeout,
	}: Pick<JobQueueOptions, "sql" | "jobs" | "now" | "runTimeout">,
	dueBy: Date,
): Promise<ClaimedJob | undefined> {
	const redeliverAt = new Date(
		now().getTime() + runTimeout.ms + REDELIVERY_BUFFER_MS,
	);
	const [row]: unknown[] = await sql`
		UPDATE core.jobs
		SET attempts = attempts + 1, next_attempt_at = ${redeliverAt}
		WHERE id = (
			SELECT id FROM core.jobs
			WHERE state = 'pending'
				AND next_attempt_at <= ${dueBy}
				AND name = ANY(${sql.array([...jobs.names()], "TEXT")}::text[])
			ORDER BY next_attempt_at, id
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, name, payload, workspace_id, enqueued_at, attempts`;
	return row === undefined ? undefined : claimedJob.parse(row);
}

async function attempt(
	claimed: ClaimedJob,
	job: RegisteredJob,
	options: AttemptOptions,
): Promise<Attempt> {
	try {
		await options.sql.begin(async (transaction) => {
			await run(transaction, claimed, job, options);
			await complete(transaction, claimed, options.now());
		});
		return { outcome: "completed" };
	} catch (error) {
		if (error instanceof SettledElsewhereError) return SETTLED_ELSEWHERE;
		return settleFailed(
			claimed,
			job,
			error instanceof JobFailedError
				? error.failure
				: { reason: "attempt_failed", error: describeThrown(error) },
			options,
		);
	}
}

async function run(
	transaction: SQL,
	claimed: ClaimedJob,
	job: RegisteredJob,
	options: Pick<JobQueueOptions, "now" | "newId" | "random" | "runTimeout">,
): Promise<void> {
	const payload = await job.validatePayload(claimed.payload);
	if (!payload.valid)
		throw new JobFailedError({
			reason: "invalid_payload",
			issues: payload.issues,
		});
	await transaction.unsafe(
		`SET LOCAL search_path TO "${pluginSchemaName(job.plugin)}"`,
	);
	const outcome = await runWithin(
		() =>
			callRun(
				job,
				{ ...enqueuedJobOf(claimed), payload: payload.value },
				contextOf(transaction, options),
			),
		options.runTimeout,
	);
	if (outcome === "timed_out")
		throw new JobFailedError({
			reason: "run_timed_out",
			timeoutMs: options.runTimeout.ms,
		});
}

async function callRun(
	job: RegisteredJob,
	enqueued: EnqueuedJob<unknown>,
	ctx: JobContext,
): Promise<void> {
	try {
		await job.run(enqueued, ctx);
	} catch (error) {
		throw new JobFailedError({
			reason: "run_threw",
			error: describeThrown(error),
		});
	}
}

async function complete(
	transaction: SQL,
	claimed: ClaimedJob,
	now: Date,
): Promise<void> {
	const completed: unknown[] = await transaction`
		UPDATE core.jobs SET state = 'completed', settled_at = ${now}
		WHERE id = ${claimed.id} AND state = 'pending'
		RETURNING id`;
	if (completed.length === 0) throw new SettledElsewhereError();
}

function settleFailed(
	claimed: ClaimedJob,
	job: RegisteredJob,
	failure: JobFailure,
	options: AttemptOptions,
): Promise<Attempt> {
	const now = options.now();
	if (!IS_RETRIED[failure.reason] || claimed.attempts >= job.maxAttempts)
		return deadLetter(options.sql, claimed, failure, now);
	const retryInMs = Math.max(
		SHORTEST_RETRY_MS,
		options.retryDelayMs(claimed.attempts - 1),
	);
	return postpone(options.sql, claimed, failure, {
		at: new Date(now.getTime() + retryInMs),
		inMs: retryInMs,
	});
}

type Retry = {
	readonly at: Date;
	readonly inMs: number;
};

async function postpone(
	sql: SQL,
	claimed: ClaimedJob,
	failure: JobFailure,
	retry: Retry,
): Promise<Attempt> {
	const postponed: unknown[] = await sql`
		UPDATE core.jobs
		SET next_attempt_at = ${retry.at}, failure_reason = ${failure.reason}
		WHERE id = ${claimed.id}
			AND state = 'pending'
			AND attempts = ${claimed.attempts}
		RETURNING id`;
	return postponed.length === 0
		? SETTLED_ELSEWHERE
		: { outcome: "postponed", failure, retryInMs: retry.inMs };
}

async function deadLetter(
	sql: SQL,
	claimed: ClaimedJob,
	failure: JobFailure,
	now: Date,
): Promise<Attempt> {
	const dead: unknown[] = await sql`
		UPDATE core.jobs
		SET state = 'dead', settled_at = ${now}, failure_reason = ${failure.reason}
		WHERE id = ${claimed.id}
			AND state = 'pending'
			AND attempts = ${claimed.attempts}
		RETURNING id`;
	return dead.length === 0
		? SETTLED_ELSEWHERE
		: { outcome: "dead_lettered", failure };
}

function report(
	claimed: ClaimedJob,
	attempt: Attempt,
	{ logger }: Pick<JobQueueOptions, "logger">,
): void {
	const jobLogger = logger.with({
		jobId: claimed.id,
		job: claimed.name,
		attempt: claimed.attempts,
	});
	switch (attempt.outcome) {
		case "completed":
			jobLogger.debug("job completed");
			return;
		case "postponed":
			jobLogger.error("job failed", {
				...attempt.failure,
				retryInMs: attempt.retryInMs,
			});
			return;
		case "dead_lettered":
			jobLogger.error("job dead-lettered", attempt.failure);
			return;
		case "settled_elsewhere":
			return;
	}
}

function enqueuedJobOf(claimed: ClaimedJob): EnqueuedJob<unknown> {
	return {
		id: claimed.id,
		name: claimed.name,
		attempt: claimed.attempts,
		enqueuedAt: claimed.enqueued_at,
		workspace: claimed.workspace_id,
		payload: claimed.payload,
	};
}

function contextOf(
	transaction: SQL,
	sources: Pick<JobQueueOptions, "now" | "newId" | "random">,
): JobContext {
	return {
		sql: transaction,
		now: sources.now,
		newId: sources.newId,
		random: sources.random,
	};
}
