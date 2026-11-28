import type { Actor, Sql } from "@workbench/sdk";
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
	created_by_api_token_id: z.string().nullable(),
	operations: scopeList,
	workspaces: scopeList,
});

const lineageRow = z.object({ revoked: z.boolean() });

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
	sql: Sql,
	token: string,
	now: Date,
): Promise<Authentication> {
	const [row] = await sql`
		SELECT id, service_account_id, expires_at, revoked_at, created_by_api_token_id, operations, workspaces
		FROM core.api_tokens
		WHERE token_hash = ${apiTokenHash(token)}`;
	if (row === undefined)
		return { authenticated: false, reason: "unknown_token" };
	const found = tokenRow.parse(row);
	if (
		found.revoked_at !== null ||
		(found.created_by_api_token_id !== null &&
			(await isLineageRevoked(sql, found.created_by_api_token_id)))
	)
		return { authenticated: false, reason: "revoked_token" };
	if (found.expires_at <= now)
		return { authenticated: false, reason: "expired_token" };
	return {
		authenticated: true,
		actor: { kind: "service_account", id: found.service_account_id },
		apiToken: {
			id: found.id,
			expiresAt: found.expires_at,
			scope: tokenScopeOf(found),
		},
	};
}

export async function isLineageRevoked(
	sql: Sql,
	apiTokenId: string,
): Promise<boolean> {
	const [row] = await sql`
		WITH RECURSIVE lineage AS (
			SELECT id, created_by_api_token_id, revoked_at FROM core.api_tokens WHERE id = ${apiTokenId}
			UNION ALL
			SELECT creator.id, creator.created_by_api_token_id, creator.revoked_at
			FROM core.api_tokens creator
			JOIN lineage ON creator.id = lineage.created_by_api_token_id
		)
		SELECT EXISTS (SELECT 1 FROM lineage WHERE revoked_at IS NOT NULL) AS revoked`;
	return lineageRow.parse(row).revoked;
}

export type ListedScope = {
	readonly operations: readonly string[] | null;
	readonly workspaces: readonly string[] | null;
};

export function tokenScopeOf(listed: ListedScope): TokenScope {
	return {
		operations: setOf(listed.operations),
		workspaces: setOf(listed.workspaces),
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
