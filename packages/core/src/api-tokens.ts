import type { Actor } from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";
import { Secret } from "./config.ts";

export const API_TOKEN_PREFIX = "wbt_";

const API_TOKEN_BYTES = 32;

export type RejectedTokenReason =
	| "unknown_token"
	| "expired_token"
	| "revoked_token";

export type TokenScope = {
	readonly operations: ReadonlySet<string> | null;
	readonly workspaces: ReadonlySet<string> | null;
};

export type CallingToken = {
	readonly id: string;
	readonly expiresAt: Date;
	readonly scope: TokenScope;
};

export type Authentication =
	| {
			readonly authenticated: true;
			readonly actor: Actor;
			readonly apiToken: CallingToken;
	  }
	| { readonly authenticated: false; readonly reason: RejectedTokenReason };

export type AuthenticatedToken = Extract<
	Authentication,
	{ readonly authenticated: true }
>;

export const scopeList = z.array(z.string()).nullable();

const tokenRow = z.object({
	id: z.string(),
	service_account_id: z.string(),
	expires_at: z.date(),
	revoked_at: z.date().nullable(),
	operations: scopeList,
	workspaces: scopeList,
});

export function newApiToken(
	randomBytes: (length: number) => Uint8Array,
): Secret {
	return new Secret(
		`${API_TOKEN_PREFIX}${Buffer.from(randomBytes(API_TOKEN_BYTES)).toString("base64url")}`,
	);
}

export function apiTokenHash(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export async function authenticateToken(
	sql: SQL,
	token: string,
	now: Date,
): Promise<Authentication> {
	const rows: unknown[] = await sql`
		SELECT id, service_account_id, expires_at, revoked_at, operations, workspaces
		FROM core.api_tokens
		WHERE token_hash = ${apiTokenHash(token)}`;
	const [row] = rows;
	if (row === undefined)
		return { authenticated: false, reason: "unknown_token" };
	const found = tokenRow.parse(row);
	if (found.revoked_at !== null)
		return { authenticated: false, reason: "revoked_token" };
	if (found.expires_at <= now)
		return { authenticated: false, reason: "expired_token" };
	return {
		authenticated: true,
		actor: { kind: "service_account", id: found.service_account_id },
		apiToken: {
			id: found.id,
			expiresAt: found.expires_at,
			scope: {
				operations: setOf(found.operations),
				workspaces: setOf(found.workspaces),
			},
		},
	};
}

function setOf(listed: readonly string[] | null): ReadonlySet<string> | null {
	return listed === null ? null : new Set(listed);
}

export function isInScope(
	listed: ReadonlySet<string> | null,
	name: string,
): boolean {
	return listed === null || listed.has(name);
}
