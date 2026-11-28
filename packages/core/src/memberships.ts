import { type Actor, START_ROLES, type StartRole } from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { isWorkspaceId } from "./workspaces.ts";

export type NewMembership = {
	readonly workspace: string;
	readonly actor: Actor;
	readonly role: StartRole;
	readonly createdAt: Date;
};

export type MembershipLookup =
	| { readonly kind: "no_workspace" }
	| { readonly kind: "not_member" }
	| { readonly kind: "member"; readonly role: StartRole };

const membershipRow = z.object({ role: z.enum(START_ROLES).nullable() });

export async function grantMembership(
	sql: SQL,
	membership: NewMembership,
): Promise<void> {
	await sql`
		INSERT INTO core.memberships (workspace_id, actor_kind, actor_id, role, created_at)
		VALUES (${membership.workspace}, ${membership.actor.kind}, ${membership.actor.id}, ${membership.role}, ${membership.createdAt})`;
}

export async function lookUpMembership(
	sql: SQL,
	workspace: string,
	actor: Actor,
): Promise<MembershipLookup> {
	if (!isWorkspaceId(workspace)) return { kind: "no_workspace" };
	const rows: unknown[] = await sql`
		SELECT m.role
		FROM core.workspaces w
		LEFT JOIN core.memberships m
			ON m.workspace_id = w.id AND m.actor_kind = ${actor.kind} AND m.actor_id = ${actor.id}
		WHERE w.id = ${workspace}`;
	const [row] = z.array(membershipRow).max(1).parse(rows);
	if (row === undefined) return { kind: "no_workspace" };
	if (row.role === null) return { kind: "not_member" };
	return { kind: "member", role: row.role };
}
