import type { Actor } from "@workbench/sdk";
import type { RoleName } from "./role-name.ts";

export type AuditSubject = {
	readonly workspace: string | null;
	readonly member: Actor | null;
	readonly role: RoleName | null;
	readonly rights: readonly string[] | null;
	readonly apiToken: string | null;
};

export const NO_AUDIT_SUBJECT: AuditSubject = {
	workspace: null,
	member: null,
	role: null,
	rights: null,
	apiToken: null,
};
