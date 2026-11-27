import { type Actor, type ActorKind, defineOperation } from "@workbench/sdk";
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

export const listAuditEntries = defineOperation({
	name: "listAuditEntries",
	kind: "query",
	target: "workspace",
	right: "core.audit.read",
	input: z.object({
		limit: z.number().int().min(1).max(MAX_LISTED_AUDIT_ENTRIES),
	}),
	output: z.object({ entries: z.array(auditEntry) }),
	execute: async ({ limit }, ctx) => {
		const rows = await ctx.sql`
			SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result
			FROM core.audit_entries
			WHERE workspace_id = ${ctx.workspace}
			ORDER BY occurred_at DESC, id DESC
			LIMIT ${limit}`;
		return { entries: z.array(auditEntryRow).parse(rows).map(auditEntryOf) };
	},
});
