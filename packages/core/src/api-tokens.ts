import type { Actor } from "@workbench/sdk";
import type { SQL } from "bun";
import { z } from "zod";

export const API_TOKEN_PREFIX = "wbt_";

export const API_TOKEN_BYTES = 32;

export type RejectedTokenReason = "unknown_token" | "expired_token";

export type Authentication =
	| { readonly authenticated: true; readonly actor: Actor }
	| { readonly authenticated: false; readonly reason: RejectedTokenReason };

const tokenRow = z.object({
	service_account_id: z.string(),
	expires_at: z.date(),
});

export function apiTokenFrom(randomBytes: Uint8Array): string {
	return `${API_TOKEN_PREFIX}${Buffer.from(randomBytes).toString("base64url")}`;
}

export function apiTokenHash(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export async function authenticateToken(
	sql: SQL,
	token: string,
	now: Date,
): Promise<Authentication> {
	const rows: unknown[] =
		await sql`SELECT service_account_id, expires_at FROM core.api_tokens WHERE token_hash = ${apiTokenHash(token)}`;
	const [row] = rows;
	if (row === undefined)
		return { authenticated: false, reason: "unknown_token" };
	const found = tokenRow.parse(row);
	if (found.expires_at <= now)
		return { authenticated: false, reason: "expired_token" };
	return {
		authenticated: true,
		actor: { kind: "service_account", id: found.service_account_id },
	};
}
