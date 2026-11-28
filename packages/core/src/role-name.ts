import { z } from "zod";
import { quote } from "./quote.ts";

declare const roleNameBrand: unique symbol;

export type RoleName = string & { readonly [roleNameBrand]: true };

const ROLE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

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

export const roleNameSchema = z.string().regex(ROLE_NAME).transform(roleName);
