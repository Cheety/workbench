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

export type FoundMembership =
	| { readonly kind: "no_workspace" }
	| { readonly kind: "not_member" }
	| { readonly kind: "member"; readonly role: StartRole };

export type MembershipLock = "share" | "none";

const membershipRow = z.object({ role: z.enum(START_ROLES) });

const workspaceRow = z.object({ id: z.string() });

export async function grantMembership(
	sql: SQL,
	membership: NewMembership,
): Promise<void> {
	await sql`
		INSERT INTO core.memberships (workspace_id, actor_kind, actor_id, role, created_at)
		VALUES (${membership.workspace}, ${membership.actor.kind}, ${membership.actor.id}, ${membership.role}, ${membership.createdAt})`;
}

export async function findMembership(
	sql: SQL,
	workspace: string,
	actor: Actor,
	lock: MembershipLock,
): Promise<FoundMembership> {
	if (!isWorkspaceId(workspace)) return { kind: "no_workspace" };
	const [membership] = z
		.array(membershipRow)
		.max(1)
		.parse(await membershipRowsOf(sql, workspace, actor, lock));
	if (membership !== undefined)
		return { kind: "member", role: membership.role };
	const [found] = z
		.array(workspaceRow)
		.max(1)
		.parse(await sql`SELECT id FROM core.workspaces WHERE id = ${workspace}`);
	return found === undefined
		? { kind: "no_workspace" }
		: { kind: "not_member" };
}

function membershipRowsOf(
	sql: SQL,
	workspace: string,
	actor: Actor,
	lock: MembershipLock,
): Promise<unknown[]> {
	switch (lock) {
		case "share":
			return sql`
				SELECT role FROM core.memberships
				WHERE workspace_id = ${workspace} AND actor_kind = ${actor.kind} AND actor_id = ${actor.id}
				FOR SHARE`;
		case "none":
			return sql`
				SELECT role FROM core.memberships
				WHERE workspace_id = ${workspace} AND actor_kind = ${actor.kind} AND actor_id = ${actor.id}`;
	}
}
