import type { Actor } from "@workbench/sdk";
import type { RoleName } from "./role-name.ts";

export type AuditSubject = {
	readonly member: Actor | null;
	readonly role: RoleName | null;
};

export const NO_AUDIT_SUBJECT: AuditSubject = { member: null, role: null };
