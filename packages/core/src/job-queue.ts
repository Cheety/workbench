import { type JobContext, type JobDefinition, jobName } from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { fullJitterBackoff } from "./database-wait.ts";
import { describeThrown, type ThrownError } from "./failure-reason.ts";
import { type HookTimeout, runWithin } from "./hook-timeout.ts";
import {
	getJob,
	type JobRegistry,
	type RegisteredCronJob,
	type RegisteredJob,
} from "./job-registry.ts";
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
	if (job === undefined || job.kind !== "enqueued")
		throw new UndeclaredJobError(enqueueing.plugin, name);
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
	readonly newJobId: () => string;
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

const MOST_CAUGHT_UP_DUE_TIMES = 10;

const claimedJob = z.object({
	id: z.string(),
	name: z.string(),
	payload: z.unknown(),
	workspace_id: z.string().nullable(),
	due_at: z.date().nullable(),
	enqueued_at: z.date(),
	attempts: z.number(),
});

type ClaimedJob = z.infer<typeof claimedJob>;

const enqueuedDetails = z.object({ workspace_id: z.string() });

const cronDetails = z.object({ due_at: z.date() });

type JobFailure =
	| { readonly reason: "run_threw"; readonly error: ThrownError }
	| { readonly reason: "run_timed_out"; readonly timeoutMs: number }
	| {
			readonly reason: "invalid_payload";
			readonly issues: readonly ValidationIssue[];
	  }
	| { readonly reason: "attempt_failed"; readonly error: ThrownError }
	| { readonly reason: "attempt_lost" };

const IS_RETRIED: Record<JobFailure["reason"], boolean> = {
	run_threw: true,
	run_timed_out: true,
	invalid_payload: false,
	attempt_failed: true,
	attempt_lost: false,
};

type AttemptOutcome =
	| { readonly outcome: "completed" }
	| {
			readonly outcome: "postponed";
			readonly failure: JobFailure;
			readonly retryInMs: number;
	  }
	| { readonly outcome: "dead_lettered"; readonly failure: JobFailure }
	| { readonly outcome: "settled_elsewhere" };

const SETTLED_ELSEWHERE: AttemptOutcome = { outcome: "settled_elsewhere" };

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
	const enqueueDueCronJobs = dueCronJobEnqueuerOf(options);
	return {
		runDue: async (stopSignal) => {
			if (options.jobs.names().length === 0) return;
			const dueBy = options.now();
			await enqueueDueCronJobs(dueBy);
			while (!stopSignal.aborted) {
				const claimed = await claimNext(options, dueBy);
				if (claimed === undefined) return;
				await attemptOrGiveUp(
					claimed,
					getJob(options.jobs, claimed.name),
					attemptOptions,
				);
			}
		},
	};
}

function dueCronJobEnqueuerOf({
	sql,
	jobs,
	newJobId,
	logger,
}: Pick<JobQueueOptions, "sql" | "jobs" | "newJobId" | "logger">): (
	dueBy: Date,
) => Promise<void> {
	const enqueuedDue = new Map<string, number>();
	const isEnqueuedBeyond = (job: RegisteredCronJob, dueBy: Date): boolean => {
		const due = enqueuedDue.get(job.name);
		return due !== undefined && due > dueBy.getTime();
	};
	return async (dueBy) => {
		for (const job of jobs.cronJobs()) {
			if (isEnqueuedBeyond(job, dueBy)) continue;
			const next = job.schedule.nextAfter(dueBy);
			const missed = await missedDueTimesOf(sql, job, dueBy);
			const dueTimes = [...missed.caughtUp, next];
			await sql`
				INSERT INTO core.jobs (id, name, due_at, enqueued_at, next_attempt_at)
				SELECT due.id, ${job.name}, due.at::timestamptz, ${dueBy}, due.at::timestamptz
				FROM unnest(
					${sql.array(
						dueTimes.map(() => newJobId()),
						"UUID",
					)}::uuid[],
					${sql.array(
						dueTimes.map((dueAt) => dueAt.toISOString()),
						"TEXT",
					)}::text[]
				) AS due (id, at)
				ON CONFLICT (name, due_at) DO NOTHING`;
			enqueuedDue.set(job.name, next.getTime());
			if (missed.skippedAfter !== undefined)
				logger.warn("cron due times skipped", {
					job: job.name,
					latestEnqueuedDueAt: missed.skippedAfter,
					oldestCaughtUpDueAt: missed.caughtUp[0],
				});
		}
	};
}

const latestDueTime = z.object({ latest: z.date().nullable() });

type MissedDueTimes = {
	readonly caughtUp: readonly Date[];
	readonly skippedAfter: Date | undefined;
};

async function missedDueTimesOf(
	sql: SQL,
	job: RegisteredCronJob,
	dueBy: Date,
): Promise<MissedDueTimes> {
	const [row]: unknown[] = await sql`
		SELECT max(due_at) AS latest FROM core.jobs WHERE name = ${job.name}`;
	const { latest } = latestDueTime.parse(row);
	if (latest === null) return { caughtUp: [], skippedAfter: undefined };
	const missed: Date[] = [];
	let due = job.schedule.latestUpTo(dueBy);
	while (due > latest && missed.length < MOST_CAUGHT_UP_DUE_TIMES) {
		missed.push(due);
		due = job.schedule.latestUpTo(new Date(due.getTime() - 1));
	}
	return {
		caughtUp: missed.toReversed(),
		skippedAfter: due > latest ? latest : undefined,
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
	const claimedAt = now();
	const redeliverAt = new Date(
		claimedAt.getTime() + runTimeout.ms + REDELIVERY_BUFFER_MS,
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
		RETURNING id, name, payload, workspace_id, due_at, enqueued_at, attempts`;
	return row === undefined ? undefined : claimedJob.parse(row);
}

async function attemptOrGiveUp(
	claimed: ClaimedJob,
	job: RegisteredJob,
	options: AttemptOptions,
): Promise<void> {
	if (claimed.attempts <= job.maxAttempts) {
		report(claimed, await runAttempt(claimed, job, options), options);
		return;
	}
	const lastAttempted = { ...claimed, attempts: job.maxAttempts };
	const outcome = await deadLetter(
		options.sql,
		claimed,
		{ reason: "attempt_lost" },
		{ at: options.now(), attempts: lastAttempted.attempts },
	);
	report(lastAttempted, outcome, options);
}

async function runAttempt(
	claimed: ClaimedJob,
	job: RegisteredJob,
	options: AttemptOptions,
): Promise<AttemptOutcome> {
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
	const call = await callOf(job, claimed);
	await transaction.unsafe(
		`SET LOCAL search_path TO "${pluginSchemaName(job.plugin)}"`,
	);
	const outcome = await runWithin(
		() => callRun(call, contextOf(transaction, options)),
		options.runTimeout,
	);
	if (outcome === "timed_out")
		throw new JobFailedError({
			reason: "run_timed_out",
			timeoutMs: options.runTimeout.ms,
		});
}

type RunCall = (ctx: JobContext) => Promise<void>;

async function callOf(
	job: RegisteredJob,
	claimed: ClaimedJob,
): Promise<RunCall> {
	const identity = {
		id: claimed.id,
		name: claimed.name,
		attempt: claimed.attempts,
	};
	switch (job.kind) {
		case "enqueued": {
			const payload = await job.validatePayload(claimed.payload);
			if (!payload.valid)
				throw new JobFailedError({
					reason: "invalid_payload",
					issues: payload.issues,
				});
			const { workspace_id } = enqueuedDetails.parse(claimed);
			return (ctx) =>
				job.run(
					{
						...identity,
						enqueuedAt: claimed.enqueued_at,
						workspace: workspace_id,
						payload: payload.value,
					},
					ctx,
				);
		}
		case "cron": {
			const { due_at } = cronDetails.parse(claimed);
			return (ctx) => job.run({ ...identity, dueAt: due_at }, ctx);
		}
	}
}

async function callRun(call: RunCall, ctx: JobContext): Promise<void> {
	try {
		await call(ctx);
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
	completedAt: Date,
): Promise<void> {
	const isCompleted = await updateIfStillClaimed(
		transaction,
		claimed,
		transaction`state = 'completed', settled_at = ${completedAt}`,
	);
	if (!isCompleted) throw new SettledElsewhereError();
}

async function updateIfStillClaimed(
	sql: SQL,
	claimed: ClaimedJob,
	assignments: SQL.Query<unknown>,
): Promise<boolean> {
	const updated: unknown[] = await sql`
		UPDATE core.jobs SET ${assignments}
		WHERE id = ${claimed.id}
			AND state = 'pending'
			AND attempts = ${claimed.attempts}
		RETURNING id`;
	return updated.length > 0;
}

function settleFailed(
	claimed: ClaimedJob,
	job: RegisteredJob,
	failure: JobFailure,
	options: AttemptOptions,
): Promise<AttemptOutcome> {
	const now = options.now();
	if (!IS_RETRIED[failure.reason] || claimed.attempts >= job.maxAttempts)
		return deadLetter(options.sql, claimed, failure, {
			at: now,
			attempts: claimed.attempts,
		});
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
): Promise<AttemptOutcome> {
	const isPostponed = await updateIfStillClaimed(
		sql,
		claimed,
		sql`next_attempt_at = ${retry.at}, failure_reason = ${failure.reason}`,
	);
	return isPostponed
		? { outcome: "postponed", failure, retryInMs: retry.inMs }
		: SETTLED_ELSEWHERE;
}

type Death = {
	readonly at: Date;
	readonly attempts: number;
};

async function deadLetter(
	sql: SQL,
	claimed: ClaimedJob,
	failure: JobFailure,
	death: Death,
): Promise<AttemptOutcome> {
	const isDead = await updateIfStillClaimed(
		sql,
		claimed,
		sql`
			state = 'dead',
			settled_at = ${death.at},
			attempts = ${death.attempts},
			failure_reason = ${failure.reason}`,
	);
	return isDead ? { outcome: "dead_lettered", failure } : SETTLED_ELSEWHERE;
}

function loggerOf(
	claimed: ClaimedJob,
	{ logger }: Pick<JobQueueOptions, "logger">,
): Logger {
	return logger.with({
		jobId: claimed.id,
		job: claimed.name,
		attempt: claimed.attempts,
	});
}

function report(
	claimed: ClaimedJob,
	settled: AttemptOutcome,
	{ logger }: Pick<JobQueueOptions, "logger">,
): void {
	const jobLogger = loggerOf(claimed, { logger });
	switch (settled.outcome) {
		case "completed":
			jobLogger.debug("job completed");
			return;
		case "postponed":
			jobLogger.error("job failed", {
				...settled.failure,
				retryInMs: settled.retryInMs,
			});
			return;
		case "dead_lettered":
			jobLogger.error("job dead-lettered", settled.failure);
			return;
		case "settled_elsewhere":
			return;
	}
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
