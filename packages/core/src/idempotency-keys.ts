import { createHash } from "node:crypto";
import { type Actor, defineCronJob, type OperationKind } from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { isRecord } from "./is-record.ts";

declare const idempotencyKeyBrand: unique symbol;

export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };

export const IDEMPOTENCY_KEY_PATTERN = "^[ -+\\--~]{1,255}$";

export const IDEMPOTENCY_KEY_RULE =
	"1 to 255 visible ASCII characters or spaces, without a comma";

const IDEMPOTENCY_KEY = new RegExp(IDEMPOTENCY_KEY_PATTERN);

const RETENTION_MS = 86_400_000;

const MOST_REMOVED_PER_RUN = 10_000;

export const TAKES_IDEMPOTENCY_KEY: Record<OperationKind, boolean> = {
	query: false,
	mutation: true,
};

export type ParsedIdempotencyKey =
	| { readonly valid: true; readonly key: IdempotencyKey }
	| { readonly valid: false };

export function parseIdempotencyKey(value: string): ParsedIdempotencyKey {
	if (!IDEMPOTENCY_KEY.test(value)) return { valid: false };
	return { valid: true, key: value as IdempotencyKey };
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

const MOST_CLAIMS = 2;

export class IdempotencyKeyKeptRemovedError extends Error {
	constructor() {
		super(
			`the idempotency key was removed each of the ${MOST_CLAIMS} times it was found claimed`,
		);
		this.name = "IdempotencyKeyKeptRemovedError";
	}
}

const storedCall = z.object({ output: z.string(), matches: z.boolean() });

type StoredCall = z.infer<typeof storedCall>;

export async function runIdempotently(
	transaction: SQL,
	call: IdempotentCall,
	run: () => Promise<unknown>,
): Promise<unknown> {
	const inputHash = inputHashOf(call.input);
	for (let attempt = 1; attempt <= MOST_CLAIMS; attempt += 1) {
		if (await claim(transaction, call, inputHash))
			return storeAnswer(transaction, call, await run());
		const stored = await findStoredCall(transaction, call, inputHash);
		if (stored !== undefined) return replay(stored);
	}
	throw new IdempotencyKeyKeptRemovedError();
}

async function claim(
	transaction: SQL,
	call: IdempotentCall,
	inputHash: string,
): Promise<boolean> {
	const claimed: unknown[] = await transaction`
		INSERT INTO core.idempotency_keys (actor_kind, actor_id, key, operation, workspace_id, input_hash, created_at)
		VALUES (${call.actor.kind}, ${call.actor.id}, ${call.key}, ${call.operation}, ${call.workspace}, ${inputHash}, ${call.calledAt})
		ON CONFLICT (actor_kind, actor_id, key) DO NOTHING
		RETURNING key`;
	return claimed.length > 0;
}

async function storeAnswer(
	transaction: SQL,
	call: IdempotentCall,
	output: unknown,
): Promise<unknown> {
	const json = jsonFormOf(output);
	await transaction`
		UPDATE core.idempotency_keys SET output = ${json}::text::json
		WHERE actor_kind = ${call.actor.kind} AND actor_id = ${call.actor.id} AND key = ${call.key}`;
	const answer: unknown = JSON.parse(json);
	return answer;
}

async function findStoredCall(
	transaction: SQL,
	call: IdempotentCall,
	inputHash: string,
): Promise<StoredCall | undefined> {
	const [row]: unknown[] = await transaction`
		SELECT
			output::text AS output,
			(operation = ${call.operation} AND workspace_id = ${call.workspace} AND input_hash = ${inputHash}) AS matches
		FROM core.idempotency_keys
		WHERE actor_kind = ${call.actor.kind} AND actor_id = ${call.actor.id} AND key = ${call.key}`;
	return row === undefined ? undefined : storedCall.parse(row);
}

function replay(stored: StoredCall): unknown {
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
