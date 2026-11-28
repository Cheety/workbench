import { defineRight, OperationError } from "@workbench/sdk";
import { z } from "zod";
import {
	apiTokenHash,
	type CallingToken,
	isLineageRevoked,
	ScopeList,
	storedScopeList,
	type TokenScope,
} from "./api-tokens.ts";
import { NO_AUDIT_SUBJECT } from "./audit-subject.ts";
import { type Keyset, pageOf, pageRequestSchema } from "./keyset-pages.ts";
import {
	defineInstanceOperation,
	type InstanceContext,
} from "./operation-registry.ts";
import { quote } from "./quote.ts";
import { expiryAfter, MAX_VALID_DAYS } from "./service-accounts.ts";

const MAX_SCOPE_ENTRIES = 100;

const MAX_OPERATION_NAME_LENGTH = 200;

const MAX_CURSOR_LENGTH = 200;

export const apiTokenManage = defineRight({
	name: "core.api-token.manage",
	defaultRoles: [],
});

function nullableUniqueList<Item extends z.ZodType<string>>(item: Item) {
	return z
		.array(item)
		.min(1)
		.max(MAX_SCOPE_ENTRIES)
		.refine((items) => new Set(items).size === items.length, {
			message: "names an entry more than once",
		})
		.nullable();
}

const listedNames = z.array(z.string()).nullable();

const listedScope = { operations: listedNames, workspaces: listedNames };

function holderOf(ctx: InstanceContext): string {
	if (ctx.actor.kind !== "service_account")
		throw new OperationError(
			"rejected",
			"not_a_service_account",
			"only a service account holds API tokens",
		);
	return ctx.actor.id;
}

function checkWithinCallingToken(
	calling: CallingToken,
	wanted: { readonly scope: TokenScope; readonly expiresAt: Date },
): void {
	if (!calling.scope.operations.covers(wanted.scope.operations))
		throw new OperationError(
			"rejected",
			"token_scope_exceeded",
			"a token cannot create a token for operations outside its own scope",
		);
	if (wanted.expiresAt > calling.expiresAt)
		throw new OperationError(
			"rejected",
			"token_scope_exceeded",
			"a token cannot create a token that expires after itself",
		);
}

async function holdCallingToken(
	ctx: InstanceContext,
	calling: CallingToken,
	now: Date,
): Promise<void> {
	const held = await ctx.sql`
		SELECT id FROM core.api_tokens
		WHERE id = ${calling.id} AND revoked_at IS NULL AND expires_at > ${now}
		FOR SHARE`;
	if (held.length === 0 || (await isLineageRevoked(ctx.sql, calling.id)))
		throw new OperationError(
			"rejected",
			"calling_token_invalid",
			"the token of the call was revoked or expired while the call ran",
		);
}

export const createApiTokenOperation = defineInstanceOperation({
	name: "createApiToken",
	kind: "mutation",
	right: apiTokenManage.name,
	input: z.object({
		validDays: z.number().int().min(1).max(MAX_VALID_DAYS),
		operations: nullableUniqueList(
			z.string().min(1).max(MAX_OPERATION_NAME_LENGTH),
		),
		workspaces: nullableUniqueList(z.uuid()),
	}),
	output: z.object({
		id: z.string(),
		token: z.string(),
		expiresAt: z.iso.datetime(),
		...listedScope,
	}),
	execute: async ({ validDays, operations, workspaces }, ctx) => {
		const holder = holderOf(ctx);
		const unknown = (operations ?? []).filter(
			(operation) => !ctx.operationNames.has(operation),
		);
		if (unknown.length > 0)
			throw new OperationError(
				"rejected",
				"unknown_scope_operation",
				`neither the core nor an active plugin has an operation named ${unknown.map(quote).join(", ")}`,
			);
		const createdAt = ctx.now();
		const expiresAt = expiryAfter(createdAt, validDays);
		const scope: TokenScope = {
			operations: ScopeList.of(operations),
			workspaces: ScopeList.of(workspaces),
		};
		const calling = ctx.apiToken;
		if (calling !== null) {
			checkWithinCallingToken(calling, { scope, expiresAt });
			await holdCallingToken(ctx, calling, createdAt);
		}
		const id = ctx.newId();
		const token = ctx.newApiToken();
		await ctx.sql`
			INSERT INTO core.api_tokens (id, service_account_id, token_hash, created_at, expires_at, operations, workspaces, created_by_api_token_id)
			VALUES (${id}, ${holder}, ${apiTokenHash(token.reveal())}, ${createdAt}, ${expiresAt}, ${scope.operations.toJson()}::text::jsonb, ${scope.workspaces.toJson()}::text::jsonb, ${calling?.id ?? null})`;
		return {
			id,
			token: token.reveal(),
			expiresAt: expiresAt.toISOString(),
			operations: scope.operations.toList(),
			workspaces: scope.workspaces.toList(),
		};
	},
	auditSubject: () => NO_AUDIT_SUBJECT,
});

const listedTokenRow = z.object({
	id: z.string(),
	created_at: z.date(),
	expires_at: z.date(),
	revoked_at: z.date().nullable(),
	operations: storedScopeList,
	workspaces: storedScopeList,
});

type TokenPosition = {
	readonly createdAt: Date;
	readonly id: string;
};

const listedTokens: Keyset<z.infer<typeof listedTokenRow>, TokenPosition> = {
	list: "the list of API tokens",
	row: listedTokenRow,
	position: z
		.tuple([z.iso.datetime(), z.guid()])
		.transform(([createdAt, id]) => ({ createdAt: new Date(createdAt), id })),
	positionOf: (row) => ({ createdAt: row.created_at, id: row.id }),
	encode: ({ createdAt, id }) => [createdAt.toISOString(), id],
};

export const listApiTokensOperation = defineInstanceOperation({
	name: "listApiTokens",
	kind: "query",
	right: apiTokenManage.name,
	input: pageRequestSchema(MAX_CURSOR_LENGTH),
	output: z.object({
		apiTokens: z.array(
			z.object({
				id: z.string(),
				createdAt: z.iso.datetime(),
				expiresAt: z.iso.datetime(),
				revokedAt: z.iso.datetime().nullable(),
				...listedScope,
			}),
		),
		nextCursor: z.string().nullable(),
	}),
	execute: async (request, ctx) => {
		const holder = holderOf(ctx);
		const page = await pageOf(listedTokens, request, (after, upTo) =>
			after === null
				? ctx.sql`
					SELECT id, created_at, expires_at, revoked_at, operations, workspaces
					FROM core.api_tokens
					WHERE service_account_id = ${holder}
					ORDER BY created_at DESC, id DESC
					LIMIT ${upTo}`
				: ctx.sql`
					SELECT id, created_at, expires_at, revoked_at, operations, workspaces
					FROM core.api_tokens
					WHERE service_account_id = ${holder}
						AND (created_at, id) < (${after.createdAt}, ${after.id})
					ORDER BY created_at DESC, id DESC
					LIMIT ${upTo}`,
		);
		return {
			apiTokens: page.rows.map((row) => ({
				id: row.id,
				createdAt: row.created_at.toISOString(),
				expiresAt: row.expires_at.toISOString(),
				revokedAt: row.revoked_at?.toISOString() ?? null,
				operations: row.operations.toList(),
				workspaces: row.workspaces.toList(),
			})),
			nextCursor: page.nextCursor,
		};
	},
});

const revokedRow = z.object({ id: z.string(), revoked_at: z.date() });

export const revokeApiTokenOperation = defineInstanceOperation({
	name: "revokeApiToken",
	kind: "mutation",
	right: apiTokenManage.name,
	input: z.object({ id: z.uuid() }),
	output: z.object({ id: z.string(), revokedAt: z.iso.datetime() }),
	execute: async ({ id }, ctx) => {
		const holder = holderOf(ctx);
		const rows = await ctx.sql`
			WITH RECURSIVE descendants AS (
				SELECT id FROM core.api_tokens WHERE id = ${id} AND service_account_id = ${holder}
				UNION ALL
				SELECT created.id FROM core.api_tokens created
				JOIN descendants ON created.created_by_api_token_id = descendants.id
			)
			UPDATE core.api_tokens
			SET revoked_at = COALESCE(revoked_at, ${ctx.now()})
			WHERE id IN (SELECT id FROM descendants)
			RETURNING id, revoked_at`;
		const revoked = z
			.array(revokedRow)
			.parse(rows)
			.find((row) => row.id === id);
		if (revoked === undefined)
			throw new OperationError(
				"not_found",
				"api_token_not_found",
				"the actor holds no API token with this id",
			);
		return { id, revokedAt: revoked.revoked_at.toISOString() };
	},
	auditSubject: () => NO_AUDIT_SUBJECT,
});
