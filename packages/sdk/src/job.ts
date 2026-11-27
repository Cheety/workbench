import type { Schema, Sql } from "./operation.ts";

export type JobContext = {
	readonly sql: Sql;
	now(): Date;
	newId(): string;
	random(): number;
};

export type EnqueuedJob<Payload> = {
	readonly id: string;
	readonly name: string;
	readonly attempt: number;
	readonly enqueuedAt: Date;
	readonly workspace: string;
	readonly payload: Payload;
};

export type JobDefinition<Payload> = {
	readonly name: string;
	readonly payload: Schema<Payload>;
	readonly maxAttempts: number;
	run(job: EnqueuedJob<Payload>, ctx: JobContext): Promise<void>;
};

export function defineJob<Payload>(
	definition: JobDefinition<Payload>,
): JobDefinition<Payload> {
	return definition;
}

const JOB_NAME_SEPARATOR = ".";

export function jobName(
	plugin: string,
	job: { readonly name: string },
): string {
	return `${plugin}${JOB_NAME_SEPARATOR}${job.name}`;
}
