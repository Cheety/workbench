import type { SQL } from "bun";

export type NewWorkspace = {
	readonly id: string;
	readonly name: string;
	readonly createdAt: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWorkspaceId(value: string): boolean {
	return UUID.test(value);
}

export async function createWorkspace(
	sql: SQL,
	workspace: NewWorkspace,
): Promise<void> {
	await sql`INSERT INTO core.workspaces (id, name, created_at) VALUES (${workspace.id}, ${workspace.name}, ${workspace.createdAt})`;
}

export async function workspaceExists(sql: SQL, id: string): Promise<boolean> {
	if (!isWorkspaceId(id)) return false;
	const rows: unknown[] =
		await sql`SELECT 1 FROM core.workspaces WHERE id = ${id}`;
	return rows.length > 0;
}
