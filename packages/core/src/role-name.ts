import { z } from "zod";
import { quote } from "./quote.ts";

const ROLE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export const roleNameSchema = z.string().regex(ROLE_NAME).brand<"RoleName">();

export type RoleName = z.infer<typeof roleNameSchema>;

export class InvalidRoleNameError extends Error {
	constructor(value: string) {
		super(
			`role name ${quote(value)} must consist of at most 63 lowercase letters, digits and hyphens and start with a letter`,
		);
		this.name = "InvalidRoleNameError";
	}
}

export function isRoleName(value: string): value is RoleName {
	return ROLE_NAME.test(value);
}

export function roleName(value: string): RoleName {
	if (!isRoleName(value)) throw new InvalidRoleNameError(value);
	return value;
}
