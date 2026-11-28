import {
	ACTOR_KINDS,
	type Actor,
	defineOperation,
	defineRight,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import type { AuditSubject } from "./audit-subject.ts";
import { type Keyset, pageOf, pageRequestSchema } from "./keyset-pages.ts";
import { defineInstanceOperation } from "./operation-registry.ts";
import { type RoleName, roleNameSchema } from "./role-name.ts";

export const DENIAL_REASONS = [
	"workspace_not_found",
	"missing_right",
	"object_not_found",
	"not_object_holder",
	"not_instance_admin",
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number];

export type AuditOutcome =
	| { readonly result: "succeeded"; readonly subject: AuditSubject }
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

const MAX_CURSOR_LENGTH = 200;

const auditedActor = z.object({ kind: z.enum(ACTOR_KINDS), id: z.string() });

function auditEntryOn<Workspace extends z.ZodType<string | null>>(
	workspace: Workspace,
) {
	const fields = {
		id: z.string(),
		occurredAt: z.iso.datetime(),
		actor: auditedActor,
		apiTokenId: z.string().nullable(),
		operation: z.string(),
		workspace,
	};
	return z.discriminatedUnion("result", [
		z.object({
			...fields,
			result: z.literal("succeeded"),
			member: auditedActor.nullable(),
			role: roleNameSchema.nullable(),
			rights: z.array(z.string()).optional(),
		}),
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
	member_kind: z.enum(ACTOR_KINDS).nullable(),
	member_id: z.string().nullable(),
	role_name: roleNameSchema.nullable(),
	rights: z.array(z.string()).nullable(),
});

type AuditEntryRow = z.infer<typeof auditEntryRow>;

class InconsistentAuditEntryError extends Error {
	constructor(id: string, problem: string) {
		super(`the audit entry ${id} ${problem}`);
		this.name = "InconsistentAuditEntryError";
	}
}

function memberOf(row: AuditEntryRow): Actor | null {
	if (row.member_kind === null && row.member_id === null) return null;
	if (row.member_kind === null || row.member_id === null)
		throw new InconsistentAuditEntryError(row.id, "names half a member");
	return { kind: row.member_kind, id: row.member_id };
}

type ListedOutcome =
	| {
			readonly result: "succeeded";
			readonly member: Actor | null;
			readonly role: RoleName | null;
			readonly rights?: string[];
	  }
	| { readonly result: "denied"; readonly reason: DenialReason };

function outcomeOf(row: AuditEntryRow): ListedOutcome {
	const member = memberOf(row);
	switch (row.result) {
		case "succeeded":
			if (row.reason !== null)
				throw new InconsistentAuditEntryError(
					row.id,
					"succeeded with a reason",
				);
			return {
				result: "succeeded",
				member,
				role: row.role_name,
				...(row.rights === null ? {} : { rights: row.rights }),
			};
		case "denied":
			if (row.reason === null)
				throw new InconsistentAuditEntryError(
					row.id,
					"was denied without a reason",
				);
			if (member !== null || row.role_name !== null || row.rights !== null)
				throw new InconsistentAuditEntryError(
					row.id,
					"was denied with a subject",
				);
			return { result: "denied", reason: row.reason };
	}
}

function auditEntryOf(row: AuditEntryRow): z.infer<typeof instanceAuditEntry> {
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
		case "succeeded": {
			const { member, role, rights } = entry.outcome.subject;
			const rightsJson = rights === null ? null : JSON.stringify(rights);
			const memberKind = member === null ? null : member.kind;
			const memberId = member === null ? null : member.id;
			await transaction`
				INSERT INTO core.audit_entries (id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason, member_kind, member_id, role_name, rights)
				VALUES (${entry.id}, ${entry.occurredAt}, ${entry.actor.kind}, ${entry.actor.id}, ${entry.apiTokenId}, ${entry.operation}, ${entry.workspace}, 'succeeded', NULL, ${memberKind}, ${memberId}, ${role}, ${rightsJson}::text::jsonb)`;
			return;
		}
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

const auditEntries: Keyset<z.infer<typeof auditEntryRow>, AuditPosition> = {
	list: "the audit",
	row: auditEntryRow,
	position: z
		.tuple([z.iso.datetime(), z.guid()])
		.transform(([occurredAt, id]) => ({
			occurredAt: new Date(occurredAt),
			id,
		})),
	positionOf: (row) => ({ occurredAt: row.occurred_at, id: row.id }),
	encode: ({ occurredAt, id }) => [occurredAt.toISOString(), id],
};

export const auditRead = defineRight({
	name: "core.audit.read",
	defaultRoles: ["owner"],
});

export const instanceAuditRead = defineRight({
	name: "core.instance-audit.read",
	defaultRoles: [],
});

const auditPageRequest = pageRequestSchema(MAX_CURSOR_LENGTH);

export const listAuditEntries = defineOperation({
	name: "listAuditEntries",
	kind: "query",
	target: "workspace",
	right: auditRead.name,
	input: auditPageRequest,
	output: z.object({
		entries: z.array(workspaceAuditEntry),
		nextCursor: z.string().nullable(),
	}),
	execute: async (request, ctx) => {
		const page = await pageOf(auditEntries, request, (after, upTo) =>
			after === null
				? ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason, member_kind, member_id, role_name, rights
					FROM core.audit_entries
					WHERE workspace_id = ${ctx.workspace}
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`
				: ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason, member_kind, member_id, role_name, rights
					FROM core.audit_entries
					WHERE workspace_id = ${ctx.workspace}
						AND (occurred_at, id) < (${after.occurredAt}, ${after.id})
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`,
		);
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
	input: auditPageRequest,
	output: z.object({
		entries: z.array(instanceAuditEntry),
		nextCursor: z.string().nullable(),
	}),
	execute: async (request, ctx) => {
		const page = await pageOf(auditEntries, request, (after, upTo) =>
			after === null
				? ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason, member_kind, member_id, role_name, rights
					FROM core.audit_entries
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`
				: ctx.sql`
					SELECT id, occurred_at, actor_kind, actor_id, api_token_id, operation, workspace_id, result, reason, member_kind, member_id, role_name, rights
					FROM core.audit_entries
					WHERE (occurred_at, id) < (${after.occurredAt}, ${after.id})
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${upTo}`,
		);
		return {
			entries: page.rows.map(auditEntryOf),
			nextCursor: page.nextCursor,
		};
	},
});
