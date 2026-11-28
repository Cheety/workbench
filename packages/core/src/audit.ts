import {
	ACTOR_KINDS,
	type Actor,
	defineOperation,
	defineRight,
	OperationError,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { defineInstanceOperation } from "./operation-registry.ts";

export const DENIAL_REASONS = [
	"workspace_not_found",
	"missing_right",
	"object_not_found",
	"not_object_holder",
	"not_instance_admin",
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number];

export type AuditOutcome =
	| { readonly result: "succeeded" }
	| { readonly result: "denied"; readonly reason: DenialReason };

export type NewAuditEntry = {
	readonly id: string;
	readonly occurredAt: Date;
	readonly actor: Actor;
	readonly apiTokenId: string | null;
	readonly operation: string;
	readonly workspace: string | null;
	readonly outcome: AuditOutcome;
};

const MAX_LISTED_AUDIT_ENTRIES = 100;

const MAX_CURSOR_LENGTH = 200;

function auditEntryOn<Workspace extends z.ZodType<string | null>>(
	workspace: Workspace,
) {
	const fields = {
		id: z.string(),
		occurredAt: z.iso.datetime(),
		actor: z.object({ kind: z.enum(ACTOR_KINDS), id: z.string() }),
		apiTokenId: z.string().nullable(),
		operation: z.string(),
		workspace,
	};
	return z.discriminatedUnion("result", [
		z.object({ ...fields, result: z.literal("succeeded") }),
		z.object({
			...fields,
			result: z.literal("denied"),
			reason: z.enum(DENIAL_REASONS),
		}),
	]);
}

const workspaceAuditEntry = auditEntryOn(z.string());

const instanceAuditEntry = auditEntryOn(z.string().nullable());

const auditEntryRow = z.object({
	id: z.string(),
	occurred_at: z.date(),
	actor_kind: z.enum(ACTOR_KINDS),
	actor_id: z.string(),
	api_token_id: z.string().nullable(),
	operation: z.string(),
	workspace_id: z.string().nullable(),
	result: z.enum(["succeeded", "denied"]),
	reason: z.enum(DENIAL_REASONS).nullable(),
});

class InconsistentAuditEntryError extends Error {
	constructor(id: string) {
		super(`the audit entry ${id} has a reason that does not match its result`);
		this.name = "InconsistentAuditEntryError";
	}
}

function outcomeOf(row: z.infer<typeof auditEntryRow>): AuditOutcome {
	switch (row.result) {
		case "succeeded":
			if (row.reason !== null) throw new InconsistentAuditEntryError(row.id);
			return { result: "succeeded" };
		case "denied":
			if (row.reason === null) throw new InconsistentAuditEntryError(row.id);
			return { result: "denied", reason: row.reason };
	}
}

function auditEntryOf(
	row: z.infer<typeof auditEntryRow>,
): z.infer<typeof instanceAuditEntry> {
	return {
		id: row.id,
		occurredAt: row.occurred_at.toISOString(),
		actor: { kind: row.actor_kind, id: row.actor_id },
		apiTokenId: row.api_token_id,
		operation: row.operation,
		workspace: row.workspace_id,
		...outcomeOf(row),
	};
}

export async function recordAuditEntry(
	transaction: SQL,
	entry: NewAuditEntry,
): Promise<void> {
	switch (entry.outcome.result) {
		case "succeeded":
			await transaction`
				INSERT INTO core.audit_entries (id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason)
				VALUES (${entry.id}, ${entry.occurredAt}, ${entry.actor.kind}, ${entry.actor.id}, ${entry.apiTokenId}, ${entry.operation}, ${entry.workspace}, 'succeeded', NULL)`;
			return;
		case "denied":
			await transaction`
				INSERT INTO core.audit_entries (id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason)
				VALUES (${entry.id}, ${entry.occurredAt}, ${entry.actor.kind}, ${entry.actor.id}, ${entry.apiTokenId}, ${entry.operation}, ${entry.workspace}, 'denied', ${entry.outcome.reason})
				ON CONFLICT (workspace_id, actor_kind, actor_id, operation, reason, (date_trunc('minute', occurred_at AT TIME ZONE 'UTC')))
					WHERE result = 'denied'
					DO NOTHING`;
			return;
	}
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

function invalidCursor(): OperationError {
	return new OperationError(
		"rejected",
		"invalid_cursor",
		"the cursor does not name a position in the audit",
	);
}

function positionOf(cursor: string): AuditPosition {
	const encoded = encodedPosition.safeParse(decodedJson(cursor));
	if (!encoded.success) throw invalidCursor();
	const [occurredAt, id] = encoded.data;
	const position = { occurredAt: new Date(occurredAt), id };
	if (cursorAfter(position) !== cursor) throw invalidCursor();
	return position;
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

export const auditRead = defineRight({
	name: "core.audit.read",
	defaultRoles: ["owner"],
});

export const instanceAuditRead = defineRight({
	name: "core.instance-audit.read",
	defaultRoles: [],
});

const auditPageInput = z.object({
	limit: z.number().int().min(1).max(MAX_LISTED_AUDIT_ENTRIES),
	cursor: z.string().max(MAX_CURSOR_LENGTH).nullable(),
});

type AuditPage = {
	readonly rows: readonly z.infer<typeof auditEntryRow>[];
	readonly nextCursor: string | null;
};

function auditPageOf(rows: readonly unknown[], limit: number): AuditPage {
	const found = z.array(auditEntryRow).parse(rows);
	const page = found.slice(0, limit);
	const last = page.at(-1);
	return {
		rows: page,
		nextCursor:
			found.length > limit && last !== undefined
				? cursorAfter({ occurredAt: last.occurred_at, id: last.id })
				: null,
	};
}

export const listAuditEntries = defineOperation({
	name: "listAuditEntries",
	kind: "query",
	target: "workspace",
	right: auditRead.name,
	input: auditPageInput,
	output: z.object({
		entries: z.array(workspaceAuditEntry),
		nextCursor: z.string().nullable(),
	}),
	execute: async ({ limit, cursor }, ctx) => {
		const upTo = limit + 1;
		const after = cursor === null ? null : positionOf(cursor);
		const rows =
			after === null
				? await ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason
					FROM core.audit_entries
					WHERE workspace_id = ${ctx.workspace}
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`
				: await ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason
					FROM core.audit_entries
					WHERE workspace_id = ${ctx.workspace}
						AND (occurred_at, id) < (${after.occurredAt}, ${after.id})
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`;
		const page = auditPageOf(rows, limit);
		return {
			entries: page.rows.map((row) => ({
				...auditEntryOf(row),
				workspace: ctx.workspace,
			})),
			nextCursor: page.nextCursor,
		};
	},
});

export const listInstanceAuditEntries = defineInstanceOperation({
	name: "listInstanceAuditEntries",
	kind: "query",
	right: instanceAuditRead.name,
	input: auditPageInput,
	output: z.object({
		entries: z.array(instanceAuditEntry),
		nextCursor: z.string().nullable(),
	}),
	execute: async ({ limit, cursor }, ctx) => {
		const upTo = limit + 1;
		const after = cursor === null ? null : positionOf(cursor);
		const rows =
			after === null
				? await ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason
					FROM core.audit_entries
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`
				: await ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason
					FROM core.audit_entries
					WHERE (occurred_at, id) < (${after.occurredAt}, ${after.id})
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`;
		const page = auditPageOf(rows, limit);
		return {
			entries: page.rows.map(auditEntryOf),
			nextCursor: page.nextCursor,
		};
	},
});
