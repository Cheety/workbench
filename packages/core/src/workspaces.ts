import { defineRight, OperationError } from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { defineInstanceOperation } from "./operation-registry.ts";

export type NewWorkspace = {
	readonly id: string;
	readonly name: string;
	readonly createdAt: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_WORKSPACE_NAME_LENGTH = 200;

const MAX_LISTED_WORKSPACES = 100;

const MAX_CURSOR_LENGTH = 2000;

export function isWorkspaceId(value: string): boolean {
	return UUID.test(value);
}

export async function createWorkspace(
	sql: SQL,
	workspace: NewWorkspace,
): Promise<void> {
	await sql`INSERT INTO core.workspaces (id, name, created_at) VALUES (${workspace.id}, ${workspace.name}, ${workspace.createdAt})`;
}

export const workspaceCreate = defineRight({
	name: "core.workspace.create",
	defaultRoles: [],
});

export const workspaceList = defineRight({
	name: "core.workspace.list",
	defaultRoles: [],
});

const workspace = z.object({ id: z.string(), name: z.string() });

export const createWorkspaceOperation = defineInstanceOperation({
	name: "createWorkspace",
	kind: "mutation",
	right: workspaceCreate.name,
	input: z.object({
		name: z.string().trim().min(1).max(MAX_WORKSPACE_NAME_LENGTH),
	}),
	output: workspace,
	execute: async ({ name }, ctx) => {
		const id = ctx.newId();
		await ctx.sql`INSERT INTO core.workspaces (id, name, created_at) VALUES (${id}, ${name}, ${ctx.now()})`;
		return { id, name };
	},
});

const listedWorkspaceRow = z.object({
	id: z.string(),
	name: z.string(),
	role: z.string(),
});

type WorkspacePosition = {
	readonly name: string;
	readonly id: string;
};

const encodedPosition = z.tuple([z.string(), z.guid()]);

function cursorAfter(position: WorkspacePosition): string {
	const encoded: z.infer<typeof encodedPosition> = [position.name, position.id];
	return Buffer.from(JSON.stringify(encoded)).toString("base64url");
}

function invalidCursor(): OperationError {
	return new OperationError(
		"rejected",
		"invalid_cursor",
		"the cursor does not name a position in the list of workspaces",
	);
}

function positionOf(cursor: string): WorkspacePosition {
	const encoded = encodedPosition.safeParse(decodedJson(cursor));
	if (!encoded.success) throw invalidCursor();
	const [name, id] = encoded.data;
	const position = { name, id };
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

export const listWorkspacesOperation = defineInstanceOperation({
	name: "listWorkspaces",
	kind: "query",
	right: workspaceList.name,
	input: z.object({
		limit: z.number().int().min(1).max(MAX_LISTED_WORKSPACES),
		cursor: z.string().max(MAX_CURSOR_LENGTH).nullable(),
	}),
	output: z.object({
		workspaces: z.array(workspace.extend({ role: z.string() })),
		nextCursor: z.string().nullable(),
	}),
	execute: async ({ limit, cursor }, ctx) => {
		const upTo = limit + 1;
		const after = cursor === null ? null : positionOf(cursor);
		const rows =
			after === null
				? await ctx.sql`
					SELECT workspaces.id, workspaces.name, memberships.role
					FROM core.memberships
					JOIN core.workspaces ON workspaces.id = memberships.workspace_id
					WHERE memberships.actor_kind = ${ctx.actor.kind} AND memberships.actor_id = ${ctx.actor.id}
					ORDER BY workspaces.name, workspaces.id
					LIMIT ${upTo}`
				: await ctx.sql`
					SELECT workspaces.id, workspaces.name, memberships.role
					FROM core.memberships
					JOIN core.workspaces ON workspaces.id = memberships.workspace_id
					WHERE memberships.actor_kind = ${ctx.actor.kind} AND memberships.actor_id = ${ctx.actor.id}
						AND (workspaces.name, workspaces.id) > (${after.name}, ${after.id})
					ORDER BY workspaces.name, workspaces.id
					LIMIT ${upTo}`;
		const found = z.array(listedWorkspaceRow).parse(rows);
		const page = found.slice(0, limit);
		const last = page.at(-1);
		return {
			workspaces: page,
			nextCursor:
				found.length > limit && last !== undefined
					? cursorAfter({ name: last.name, id: last.id })
					: null,
		};
	},
});
