import type { SQL } from "bun";
import { apiTokenHash } from "./api-tokens.ts";

export type NewServiceAccount = {
	readonly name: string;
	readonly expiresAt: Date;
};

export type ServiceAccountSources = {
	readonly now: () => Date;
	readonly newId: () => string;
	readonly newToken: () => string;
};

export type IssuedToken = {
	readonly serviceAccountId: string;
	readonly token: string;
	readonly expiresAt: Date;
};

export async function createServiceAccount(
	sql: SQL,
	account: NewServiceAccount,
	sources: ServiceAccountSources,
): Promise<IssuedToken> {
	const serviceAccountId = sources.newId();
	const tokenId = sources.newId();
	const token = sources.newToken();
	const createdAt = sources.now();
	await sql.begin(async (transaction) => {
		await transaction`INSERT INTO core.service_accounts (id, name, created_at) VALUES (${serviceAccountId}, ${account.name}, ${createdAt})`;
		await transaction`INSERT INTO core.api_tokens (id, service_account_id, token_hash, created_at, expires_at) VALUES (${tokenId}, ${serviceAccountId}, ${apiTokenHash(token)}, ${createdAt}, ${account.expiresAt})`;
	});
	return { serviceAccountId, token, expiresAt: account.expiresAt };
}
