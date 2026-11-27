import type { SQL } from "bun";
import { apiTokenHash } from "./api-tokens.ts";
import type { Secret } from "./config.ts";

export type NewServiceAccount = {
	readonly name: string;
	readonly validDays: number;
};

export type ServiceAccountSources = {
	readonly now: () => Date;
	readonly newId: () => string;
	readonly newToken: () => Secret;
};

export type IssuedToken = {
	readonly serviceAccountId: string;
	readonly token: Secret;
	readonly expiresAt: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_VALID_DAYS = 3650;

export class InvalidValidDaysError extends Error {
	constructor(validDays: number) {
		super(
			`a token is valid for a whole number of days from 1 to ${MAX_VALID_DAYS}, not ${validDays}`,
		);
		this.name = "InvalidValidDaysError";
	}
}

export function checkValidDays(validDays: number): void {
	if (
		!Number.isInteger(validDays) ||
		validDays < 1 ||
		validDays > MAX_VALID_DAYS
	)
		throw new InvalidValidDaysError(validDays);
}

export async function createServiceAccount(
	sql: SQL,
	account: NewServiceAccount,
	sources: ServiceAccountSources,
): Promise<IssuedToken> {
	checkValidDays(account.validDays);
	const serviceAccountId = sources.newId();
	const tokenId = sources.newId();
	const token = sources.newToken();
	const createdAt = sources.now();
	const expiresAt = new Date(createdAt.getTime() + account.validDays * DAY_MS);
	await sql.begin(async (transaction) => {
		await transaction`INSERT INTO core.service_accounts (id, name, created_at) VALUES (${serviceAccountId}, ${account.name}, ${createdAt})`;
		await transaction`INSERT INTO core.api_tokens (id, service_account_id, token_hash, created_at, expires_at) VALUES (${tokenId}, ${serviceAccountId}, ${apiTokenHash(token.reveal())}, ${createdAt}, ${expiresAt})`;
	});
	return { serviceAccountId, token, expiresAt };
}
