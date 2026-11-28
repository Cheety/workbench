import { START_ROLES, type StartRole } from "@workbench/sdk";
import { isRecord } from "./is-record.ts";
import { describeOwner, type Owner, ownerName } from "./owner.ts";
import { quote } from "./quote.ts";

export type DeclaredRights = ReadonlyMap<string, ReadonlySet<StartRole>>;

export type RightsRead = {
	readonly value: DeclaredRights;
	readonly problems: readonly string[];
};

const RIGHT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export function isRightOf(owner: Owner, right: unknown): right is string {
	return (
		typeof right === "string" &&
		right.startsWith(`${ownerName(owner)}.`) &&
		RIGHT_NAME.test(right)
	);
}

export function readRights(owner: Owner, declared: unknown): RightsRead {
	if (declared === undefined) return { value: new Map(), problems: [] };
	if (!Array.isArray(declared))
		return { value: new Map(), problems: ["rights must be a list of rights"] };
	const value = new Map<string, ReadonlySet<StartRole>>();
	const problems: string[] = [];
	for (const [position, candidate] of declared.entries()) {
		const read = readRight(owner, position, candidate);
		if (!read.valid) {
			problems.push(read.problem);
			continue;
		}
		if (value.has(read.name)) {
			problems.push(`right ${quote(read.name)} is declared more than once`);
			continue;
		}
		value.set(read.name, read.defaultRoles);
	}
	return { value, problems };
}

type RightRead =
	| {
			readonly valid: true;
			readonly name: string;
			readonly defaultRoles: ReadonlySet<StartRole>;
	  }
	| { readonly valid: false; readonly problem: string };

function readRight(
	owner: Owner,
	position: number,
	candidate: unknown,
): RightRead {
	if (!isRecord(candidate) || !isRightOf(owner, candidate.name))
		return {
			valid: false,
			problem: `rights[${position}] must be named as a right of ${describeOwner(owner)}, such as ${quote(`${ownerName(owner)}.workspace.edit`)}`,
		};
	const { name, defaultRoles } = candidate;
	const roles = startRolesOf(defaultRoles);
	if (roles === undefined)
		return {
			valid: false,
			problem: `right ${quote(name)} must list its default roles, each once, out of ${START_ROLES.map(quote).join(", ")}`,
		};
	return { valid: true, name, defaultRoles: roles };
}

function startRolesOf(declared: unknown): ReadonlySet<StartRole> | undefined {
	if (!Array.isArray(declared)) return undefined;
	const roles = new Set<StartRole>();
	for (const candidate of declared) {
		const role = START_ROLES.find((startRole) => startRole === candidate);
		if (role === undefined || roles.has(role)) return undefined;
		roles.add(role);
	}
	return roles;
}
