import {
	ACTOR_KINDS,
	type Actor,
	defineRight,
	OperationError,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { defineInstanceAdminWorkspaceOperation } from "./operation-registry.ts";
import { quote } from "./quote.ts";
import { type RoleName, roleName, roleNameSchema } from "./role-name.ts";
import { isWorkspaceId } from "./workspaces.ts";

export type NewMembership = {
	readonly workspace: string;
	readonly actor: Actor;
	readonly role: RoleName;
	readonly createdAt: Date;
};

export type FoundMembership =
	| { readonly kind: "no_workspace" }
	| { readonly kind: "not_member" }
	| { readonly kind: "member"; readonly role: RoleName };

export type MembershipLock = "share" | "none";

const MAX_ACTOR_ID_LENGTH = 200;

const membershipRow = z.object({ role: roleNameSchema });

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
				SELECT memberships.role FROM core.memberships
				JOIN core.roles ON roles.name = memberships.role
				WHERE memberships.workspace_id = ${workspace} AND memberships.actor_kind = ${actor.kind} AND memberships.actor_id = ${actor.id}
				FOR SHARE OF memberships, roles`;
		case "none":
			return sql`
				SELECT role FROM core.memberships
				WHERE workspace_id = ${workspace} AND actor_kind = ${actor.kind} AND actor_id = ${actor.id}`;
	}
}

export const membershipManage = defineRight({
	name: "core.membership.manage",
	defaultRoles: [],
});

const memberActor = z.object({
	kind: z.enum(ACTOR_KINDS),
	id: z.string().min(1).max(MAX_ACTOR_ID_LENGTH),
});

export const grantMembershipOperation = defineInstanceAdminWorkspaceOperation({
	name: "grantMembership",
	kind: "mutation",
	target: "workspace",
	right: membershipManage.name,
	input: z.object({ actor: memberActor, role: roleNameSchema }),
	output: z.object({
		workspace: z.string(),
		actor: memberActor,
		role: z.string(),
	}),
	execute: async ({ actor, role }, ctx) => {
		const roles = await ctx.sql`
			SELECT name FROM core.roles WHERE name = ${role} FOR SHARE`;
		if (roles.length === 0)
			throw new OperationError(
				"not_found",
				"unknown_role",
				`no role is named ${quote(role)}`,
			);
		await ctx.sql`
			INSERT INTO core.memberships (workspace_id, actor_kind, actor_id, role, created_at)
			VALUES (${ctx.workspace}, ${actor.kind}, ${actor.id}, ${role}, ${ctx.now()})
			ON CONFLICT (workspace_id, actor_kind, actor_id) DO UPDATE SET role = EXCLUDED.role`;
		return { workspace: ctx.workspace, actor, role };
	},
	auditSubject: ({ actor, role }) => ({ member: actor, role }),
});

export const revokeMembershipOperation = defineInstanceAdminWorkspaceOperation({
	name: "revokeMembership",
	kind: "mutation",
	target: "workspace",
	right: membershipManage.name,
	input: z.object({ actor: memberActor }),
	output: z.object({ revoked: z.boolean(), role: z.string().nullable() }),
	execute: async ({ actor }, ctx) => {
		const [revoked] = z
			.array(membershipRow)
			.max(1)
			.parse(
				await ctx.sql`
					DELETE FROM core.memberships
					WHERE workspace_id = ${ctx.workspace} AND actor_kind = ${actor.kind} AND actor_id = ${actor.id}
					RETURNING role`,
			);
		return revoked === undefined
			? { revoked: false, role: null }
			: { revoked: true, role: revoked.role };
	},
	auditSubject: ({ actor }, { role }) => ({
		member: actor,
		role: role === null ? null : roleName(role),
	}),
});
