import { createHash } from "node:crypto";
import type { Actor } from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { isRecord } from "./is-record.ts";

const IDEMPOTENCY_KEY = /^[ -~]{1,255}$/;

export function isIdempotencyKey(value: string): boolean {
	return IDEMPOTENCY_KEY.test(value);
}

export type IdempotentCall = {
	readonly actor: Actor;
	readonly key: string;
	readonly operation: string;
	readonly workspace: string;
	readonly input: unknown;
	readonly calledAt: Date;
};

export class IdempotencyKeyReusedError extends Error {
	constructor() {
		super(
			"the idempotency key was already used with another operation, workspace or input",
		);
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
