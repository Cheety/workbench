import { createHash } from "node:crypto";
import { type Actor, defineCronJob, type OperationKind } from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { isRecord } from "./is-record.ts";

declare const idempotencyKeyBrand: unique symbol;

export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };

export const IDEMPOTENCY_KEY_PATTERN = "^[ -~]{1,255}$";

const IDEMPOTENCY_KEY = new RegExp(IDEMPOTENCY_KEY_PATTERN);

const RETENTION_MS = 86_400_000;

const MOST_REMOVED_PER_RUN = 10_000;

export const TAKES_IDEMPOTENCY_KEY: Record<OperationKind, boolean> = {
	query: false,
	mutation: true,
};

export class InvalidIdempotencyKeyError extends Error {
	constructor() {
		super(`an idempotency key must match ${IDEMPOTENCY_KEY_PATTERN}`);
		this.name = "InvalidIdempotencyKeyError";
	}
}

export function idempotencyKey(value: string): IdempotencyKey {
	if (!IDEMPOTENCY_KEY.test(value)) throw new InvalidIdempotencyKeyError();
	return value as IdempotencyKey;
}

export type IdempotentCall = {
	readonly actor: Actor;
	readonly key: IdempotencyKey;
	readonly operation: string;
	readonly workspace: string;
	readonly input: unknown;
	readonly calledAt: Date;
};

export class IdempotencyKeyReusedError extends Error {
	constructor() {
		super("the idempotency key belongs to another call");
		this.name = "IdempotencyKeyReusedError";
	}
}

const storedCall = z.object({ output: z.string(), matches: z.boolean() });

export async function runIdempotently(
	transaction: SQL,
	call: IdempotentCall,
	run: () => Promise<unknown>,
): Promise<unknown> {
	const inputHash = inputHashOf(call.input);
	const claimed: unknown[] = await transaction`
		INSERT INTO core.idempotency_keys (actor_kind, actor_id, key, operation, workspace_id, input_hash, created_at)
		VALUES (${call.actor.kind}, ${call.actor.id}, ${call.key}, ${call.operation}, ${call.workspace}, ${inputHash}, ${call.calledAt})
		ON CONFLICT (actor_kind, actor_id, key) DO NOTHING
		RETURNING key`;
	if (claimed.length === 0) return replayed(transaction, call, inputHash);
	const output = jsonFormOf(await run());
	await transaction`
		UPDATE core.idempotency_keys SET output = ${output}::text::json
		WHERE actor_kind = ${call.actor.kind} AND actor_id = ${call.actor.id} AND key = ${call.key}`;
	const answer: unknown = JSON.parse(output);
	return answer;
}

async function replayed(
	transaction: SQL,
	call: IdempotentCall,
	inputHash: string,
): Promise<unknown> {
	const [row]: unknown[] = await transaction`
		SELECT
			output::text AS output,
			(operation = ${call.operation} AND workspace_id = ${call.workspace} AND input_hash = ${inputHash}) AS matches
		FROM core.idempotency_keys
		WHERE actor_kind = ${call.actor.kind} AND actor_id = ${call.actor.id} AND key = ${call.key}`;
	const stored = storedCall.parse(row);
	if (!stored.matches) throw new IdempotencyKeyReusedError();
	const answer: unknown = JSON.parse(stored.output);
	return answer;
}

function inputHashOf(input: unknown): string {
	return createHash("sha256").update(canonicalJsonOf(input)).digest("hex");
}

function canonicalJsonOf(value: unknown): string {
	return (
		JSON.stringify(value, (_key, item: unknown) =>
			isRecord(item)
				? Object.fromEntries(
						Object.entries(item).toSorted(([left], [right]) =>
							left < right ? -1 : left > right ? 1 : 0,
						),
					)
				: item,
		) ?? "null"
	);
}

function jsonFormOf(output: unknown): string {
	return JSON.stringify(output) ?? "null";
}

export const removeExpiredIdempotencyKeys = defineCronJob({
	name: "removeExpiredIdempotencyKeys",
	schedule: "*/10 * * * *",
	maxAttempts: 3,
	run: async (_job, ctx) => {
		const expiredBy = new Date(ctx.now().getTime() - RETENTION_MS);
		await ctx.sql`
			DELETE FROM core.idempotency_keys
			WHERE (actor_kind, actor_id, key) IN (
				SELECT actor_kind, actor_id, key FROM core.idempotency_keys
				WHERE created_at <= ${expiredBy}
				ORDER BY created_at
				LIMIT ${MOST_REMOVED_PER_RUN}
				FOR UPDATE SKIP LOCKED
			)`;
	},
});
