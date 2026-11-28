import {
	defineRight,
	OperationError,
	type Sql,
	START_ROLES,
	type StartRole,
} from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { defineInstanceOperation } from "./operation-registry.ts";
import { quote } from "./quote.ts";
import { type RoleName, roleNameSchema } from "./role-name.ts";

const MAX_RIGHTS_OF_A_ROLE = 200;

const MAX_RIGHT_NAME_LENGTH = 200;

export function isStartRole(role: RoleName): role is RoleName & StartRole {
	return START_ROLES.some((startRole) => startRole === role);
}

const grantedRow = z.object({ granted: z.boolean() });

export type RoleShare = "shared" | "no_role";

export async function shareRole(sql: Sql, role: RoleName): Promise<RoleShare> {
	const roles =
		await sql`SELECT name FROM core.roles WHERE name = ${role} FOR SHARE`;
	return roles.length === 0 ? "no_role" : "shared";
}

export async function customRoleGrants(
	sql: SQL,
	role: RoleName,
	right: string,
): Promise<boolean> {
	const [row] = await sql`
		SELECT EXISTS (
			SELECT 1 FROM core.role_rights WHERE role_name = ${role} AND right_name = ${right}
		) AS granted`;
	return grantedRow.parse(row).granted;
}

export const roleDefine = defineRight({
	name: "core.role.define",
	defaultRoles: [],
});

export const defineRoleOperation = defineInstanceOperation({
	name: "defineRole",
	kind: "mutation",
	right: roleDefine.name,
	input: z.object({
		name: roleNameSchema,
		rights: z
			.array(z.string().min(1).max(MAX_RIGHT_NAME_LENGTH))
			.max(MAX_RIGHTS_OF_A_ROLE)
			.refine((rights) => new Set(rights).size === rights.length, {
				message: "names a right more than once",
			}),
	}),
	output: z.object({ name: roleNameSchema, rights: z.array(z.string()) }),
	execute: async ({ name, rights }, ctx) => {
		if (isStartRole(name))
			throw new OperationError(
				"rejected",
				"start_role_not_definable",
				`the start role ${quote(name)} takes its rights from the plugins and cannot be defined`,
			);
		const unknown = rights.filter((right) => !ctx.grantableRights.has(right));
		if (unknown.length > 0)
			throw new OperationError(
				"rejected",
				"unknown_right",
				`no active plugin and not the core grants ${unknown.map(quote).join(", ")} through a role`,
			);
		await ctx.sql`
			INSERT INTO core.roles (name, created_at) VALUES (${name}, ${ctx.now()})
			ON CONFLICT (name) DO NOTHING`;
		await ctx.sql`SELECT name FROM core.roles WHERE name = ${name} FOR UPDATE`;
		await ctx.sql`DELETE FROM core.role_rights WHERE role_name = ${name}`;
		await ctx.sql`
			INSERT INTO core.role_rights (role_name, right_name)
			SELECT ${name}, value FROM jsonb_array_elements_text(${JSON.stringify(rights)}::text::jsonb)`;
		return { name, rights: rights.toSorted() };
	},
	auditSubject: ({ name }) => ({ workspace: null, member: null, role: name }),
});
