import {
	type Actor,
	type ActorKind,
	defineOperation,
	OperationError,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";

export type NewAuditEntry = {
	readonly id: string;
	readonly occurredAt: Date;
	readonly actor: Actor;
	readonly apiTokenId: string | null;
	readonly operation: string;
	readonly workspace: string;
};

const ACTOR_KINDS = [
	"user",
	"service_account",
] as const satisfies readonly ActorKind[];

const AUDIT_RESULTS = ["succeeded"] as const;

type AuditResult = (typeof AUDIT_RESULTS)[number];

const SUCCEEDED: AuditResult = "succeeded";

const MAX_LISTED_AUDIT_ENTRIES = 100;

const MAX_CURSOR_LENGTH = 200;

const auditEntry = z.object({
	id: z.string(),
	occurredAt: z.string(),
	actor: z.object({ kind: z.enum(ACTOR_KINDS), id: z.string() }),
	apiTokenId: z.string().nullable(),
	operation: z.string(),
	workspace: z.string(),
	result: z.enum(AUDIT_RESULTS),
});

const auditEntryRow = z.object({
	id: z.string(),
	occurred_at: z.date(),
	actor_kind: z.enum(ACTOR_KINDS),
	actor_id: z.string(),
	api_token_id: z.string().nullable(),
	operation: z.string(),
	workspace_id: z.string(),
	result: z.enum(AUDIT_RESULTS),
});

function auditEntryOf(
	row: z.infer<typeof auditEntryRow>,
): z.infer<typeof auditEntry> {
	return {
		id: row.id,
		occurredAt: row.occurred_at.toISOString(),
		actor: { kind: row.actor_kind, id: row.actor_id },
		apiTokenId: row.api_token_id,
		operation: row.operation,
		workspace: row.workspace_id,
		result: row.result,
	};
}

export async function recordAuditEntry(
	transaction: SQL,
	entry: NewAuditEntry,
): Promise<void> {
	await transaction`
		INSERT INTO core.audit_entries (id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result)
		VALUES (${entry.id}, ${entry.occurredAt}, ${entry.actor.kind}, ${entry.actor.id}, ${entry.apiTokenId}, ${entry.operation}, ${entry.workspace}, ${SUCCEEDED})`;
}

type AuditPosition = {
	readonly occurredAt: Date;
	readonly id: string;
};

const encodedPosition = z.tuple([z.iso.datetime(), z.guid()]);

function cursorAfter(position: AuditPosition): string {
	const encoded: z.infer<typeof encodedPosition> = [
		position.occurredAt.toISOString(),
		position.id,
	];
	return Buffer.from(JSON.stringify(encoded)).toString("base64url");
}

function positionOf(cursor: string): AuditPosition {
	const position = encodedPosition.safeParse(decodedJson(cursor));
	if (!position.success)
		throw new OperationError(
			"rejected",
			"invalid_cursor",
			"the cursor is not one that a page of the audit named",
		);
	const [occurredAt, id] = position.data;
	return { occurredAt: new Date(occurredAt), id };
}

function decodedJson(cursor: string): unknown {
	try {
		const decoded: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		return decoded;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export const listAuditEntries = defineOperation({
	name: "listAuditEntries",
	kind: "query",
	target: "workspace",
	right: "core.audit.read",
	input: z.object({
		limit: z.number().int().min(1).max(MAX_LISTED_AUDIT_ENTRIES),
		cursor: z.string().max(MAX_CURSOR_LENGTH).nullable(),
	}),
	output: z.object({
		entries: z.array(auditEntry),
		nextCursor: z.string().nullable(),
	}),
	execute: async ({ limit, cursor }, ctx) => {
		const upTo = limit + 1;
		const after = cursor === null ? null : positionOf(cursor);
		const rows =
			after === null
				? await ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result
					FROM core.audit_entries
					WHERE workspace_id = ${ctx.workspace}
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`
				: await ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result
					FROM core.audit_entries
					WHERE workspace_id = ${ctx.workspace}
						AND (occurred_at, id) < (${after.occurredAt}, ${after.id})
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`;
		const found = z.array(auditEntryRow).parse(rows);
		const page = found.slice(0, limit);
		const last = page.at(-1);
		return {
			entries: page.map(auditEntryOf),
			nextCursor:
				found.length > limit && last !== undefined
					? cursorAfter({ occurredAt: last.occurred_at, id: last.id })
					: null,
		};
	},
});
