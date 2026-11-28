import type { Actor, Sql } from "@workbench/sdk";
import { z } from "zod";
import { Secret } from "./config.ts";

export const API_TOKEN_PREFIX = "wbt_";

const API_TOKEN_BYTES = 32;

export type RejectedTokenReason =
	| "unknown_token"
	| "expired_token"
	| "revoked_token";

export class ScopeList {
	static readonly UNLIMITED = new ScopeList(null);

	private readonly names: ReadonlySet<string> | null;

	private constructor(names: ReadonlySet<string> | null) {
		this.names = names;
	}

	static of(listed: readonly string[] | null): ScopeList {
		return listed === null
			? ScopeList.UNLIMITED
			: new ScopeList(new Set(listed));
	}

	isUnlimited(): boolean {
		return this.names === null;
	}

	includes(name: string): boolean {
		return this.names === null || this.names.has(name);
	}

	covers(other: ScopeList): boolean {
		if (this.names === null) return true;
		if (other.names === null) return false;
		return [...other.names].every((name) => this.includes(name));
	}

	toList(): string[] | null {
		return this.names === null ? null : [...this.names].toSorted();
	}

	toJson(): string | null {
		const listed = this.toList();
		return listed === null ? null : JSON.stringify(listed);
	}
}

export type TokenScope = {
	readonly operations: ScopeList;
	readonly workspaces: ScopeList;
};

export const UNLIMITED_TOKEN_SCOPE: TokenScope = {
	operations: ScopeList.UNLIMITED,
	workspaces: ScopeList.UNLIMITED,
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

export const storedScopeList = z
	.array(z.string())
	.nullable()
	.transform(ScopeList.of);

const tokenRow = z.object({
	id: z.string(),
	service_account_id: z.string(),
	expires_at: z.date(),
	revoked_at: z.date().nullable(),
	created_by_api_token_id: z.string().nullable(),
	operations: storedScopeList,
	workspaces: storedScopeList,
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
			scope: { operations: found.operations, workspaces: found.workspaces },
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
