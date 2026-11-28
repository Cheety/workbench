import { afterEach, describe, expect, test } from "bun:test";
import { defineOperation, definePlugin } from "@workbench/sdk";
import { z } from "zod";
import type { PluginPackage } from "./kernel.ts";
import { grantMembership } from "./memberships.ts";
import { roleName } from "./role-name.ts";
import {
	API_INSTANCE_WORKSPACE,
	type ApiInstance,
	startApiInstance,
} from "./testing/api-instance.ts";
import {
	type OperationHarness,
	startOperationHarness,
} from "./testing/operation-harness.ts";
import { createWorkspace } from "./workspaces.ts";

const WORKSPACE = API_INSTANCE_WORKSPACE;

const OTHER_WORKSPACE = "00000000-0000-4000-8000-00000000bbbb";

const NOW = new Date("2026-11-26T08:00:00.000Z");

const IN_A_WEEK = new Date("2026-12-03T08:00:00.000Z");

const addEntry = defineOperation({
	name: "addEntry",
	kind: "mutation",
	target: "workspace",
	right: "ledger.entry.add",
	input: z.object({}),
	output: z.object({ added: z.boolean() }),
	execute: async () => ({ added: true }),
});

const readEntries = defineOperation({
	name: "readEntries",
	kind: "query",
	target: "workspace",
	right: "ledger.entry.read",
	input: z.object({}),
	output: z.object({ read: z.boolean() }),
	execute: async () => ({ read: true }),
});

const ledger: PluginPackage = {
	packageName: "@workbench/plugin-ledger",
	pluginName: "ledger",
	version: "1.0.0",
	loadDefinition: async () =>
		definePlugin({
			manifest: { name: "ledger" },
			rights: [
				{ name: "ledger.entry.add", defaultRoles: ["owner", "editor"] },
				{
					name: "ledger.entry.read",
					defaultRoles: ["owner", "editor", "viewer"],
				},
			],
			operations: [addEntry, readEntries],
		}),
};

const instances: ApiInstance[] = [];

const harnesses: OperationHarness[] = [];

afterEach(async () => {
	for (const instance of instances.splice(0)) await instance.stop();
	for (const harness of harnesses.splice(0)) await harness.stop();
});

async function startLedgerInstance(): Promise<ApiInstance> {
	const instance = await startApiInstance([ledger]);
	instances.push(instance);
	return instance;
}

function bearer(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

function onWorkspace(workspace: string, operation: string): string {
	return `/api/workspaces/${workspace}/operations/${operation}`;
}

function onInstance(operation: string): string {
	return `/api/operations/${operation}`;
}

type TokenScope = {
	readonly operations: readonly string[] | null;
	readonly workspaces: readonly string[] | null;
};

const createdToken = z.object({ id: z.string(), token: z.string() });

async function createdTokenOf(
	response: Response,
): Promise<z.infer<typeof createdToken>> {
	return createdToken.parse(await response.json());
}

async function joinOtherWorkspace(
	api: ApiInstance,
	serviceAccountId: string,
): Promise<void> {
	await createWorkspace(api.database.sql, {
		id: OTHER_WORKSPACE,
		name: "Other",
		createdAt: NOW,
	});
	await grantMembership(api.database.sql, {
		workspace: OTHER_WORKSPACE,
		actor: { kind: "service_account", id: serviceAccountId },
		role: roleName("owner"),
		createdAt: NOW,
	});
}

async function createToken(
	api: ApiInstance,
	token: string,
	scope: TokenScope & { readonly validDays: number },
): Promise<z.infer<typeof createdToken>> {
	const response = await api.post(
		onInstance("core.createApiToken"),
		JSON.stringify(scope),
		bearer(token),
	);
	return createdTokenOf(response);
}

describe("an API token scoped to operations", () => {
	test("calls an operation in its scope and is refused one outside it with 403 operation_outside_token_scope", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const scoped = await createToken(api, owner, {
			operations: ["ledger.readEntries"],
			workspaces: null,
			validDays: 7,
		});

		const inScope = await api.post(
			onWorkspace(WORKSPACE, "ledger.readEntries"),
			"{}",
			bearer(scoped.token),
		);
		const outOfScope = await api.post(
			onWorkspace(WORKSPACE, "ledger.addEntry"),
			"{}",
			bearer(scoped.token),
		);

		expect(inScope.status).toBe(200);
		expect(outOfScope.status).toBe(403);
		expect(await outOfScope.json()).toMatchObject({
			code: "operation_outside_token_scope",
		});
	});

	test("is refused an operation its actor lacks the right of with 403 missing_right, even when the scope names it", async () => {
		const api = await startLedgerInstance();
		const viewer = await api.issueToken("viewer");
		const scoped = await createToken(api, viewer, {
			operations: ["ledger.addEntry"],
			workspaces: null,
			validDays: 7,
		});

		const response = await api.post(
			onWorkspace(WORKSPACE, "ledger.addEntry"),
			"{}",
			bearer(scoped.token),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "missing_right" });
	});

	test("leaves a denied audit entry naming the token and operation_outside_token_scope", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const scoped = await createToken(api, owner, {
			operations: ["ledger.readEntries"],
			workspaces: null,
			validDays: 7,
		});
		await api.post(
			onWorkspace(WORKSPACE, "ledger.addEntry"),
			"{}",
			bearer(scoped.token),
		);

		const response = await api.post(
			onWorkspace(WORKSPACE, "core.listAuditEntries"),
			JSON.stringify({ limit: 10, cursor: null }),
			bearer(owner),
		);

		expect(await response.json()).toMatchObject({
			entries: expect.arrayContaining([
				expect.objectContaining({
					apiTokenId: scoped.id,
					operation: "ledger.addEntry",
					result: "denied",
					reason: "operation_outside_token_scope",
				}),
			]),
		});
	});

	test.each([
		{ case: "another operation", operations: ["ledger.addEntry"] },
		{ case: "every operation", operations: null },
	])(
		"cannot create a token for $case outside its own scope",
		async ({ operations }) => {
			const api = await startLedgerInstance();
			const owner = await api.issueToken("owner");
			const scoped = await createToken(api, owner, {
				operations: ["core.createApiToken", "ledger.readEntries"],
				workspaces: null,
				validDays: 7,
			});

			const response = await api.post(
				onInstance("core.createApiToken"),
				JSON.stringify({ operations, workspaces: null, validDays: 1 }),
				bearer(scoped.token),
			);

			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				code: "core.token_scope_exceeded",
			});
		},
	);

	test("creates a token for operations inside its own scope", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const scoped = await createToken(api, owner, {
			operations: ["core.createApiToken", "ledger.readEntries"],
			workspaces: null,
			validDays: 7,
		});

		const response = await api.post(
			onInstance("core.createApiToken"),
			JSON.stringify({
				operations: ["ledger.readEntries"],
				workspaces: [WORKSPACE],
				validDays: 1,
			}),
			bearer(scoped.token),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			operations: ["ledger.readEntries"],
			workspaces: [WORKSPACE],
		});
	});

	test.each(["core.listWorkspaces", "core.revokeApiToken"])(
		"is refused %s on the instance outside its scope with 403 operation_outside_token_scope",
		async (operation) => {
			const api = await startLedgerInstance();
			const owner = await api.issueToken("owner");
			const scoped = await createToken(api, owner, {
				operations: ["ledger.readEntries"],
				workspaces: null,
				validDays: 7,
			});

			const response = await api.post(
				onInstance(operation),
				JSON.stringify({ limit: 10, cursor: null, id: scoped.id }),
				bearer(scoped.token),
			);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: "operation_outside_token_scope",
			});
		},
	);

	test("refuses an instance admin an operation on a workspace outside its scope with 403 operation_outside_token_scope", async () => {
		const api = await startLedgerInstance();
		const admin = await api.issueInstanceAdminToken();
		const member = await api.issueIdentifiedToken("viewer");
		const scoped = await createToken(api, admin.token, {
			operations: ["core.revokeMembership"],
			workspaces: null,
			validDays: 7,
		});

		const response = await api.post(
			onWorkspace(WORKSPACE, "core.grantMembership"),
			JSON.stringify({
				actor: { kind: "service_account", id: member.serviceAccountId },
				role: "editor",
			}),
			bearer(scoped.token),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "operation_outside_token_scope",
		});
	});

	test("rejects a scope naming an operation neither the core nor a plugin has with core.unknown_scope_operation", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");

		const response = await api.post(
			onInstance("core.createApiToken"),
			JSON.stringify({
				operations: ["ledger.removeEntry"],
				workspaces: null,
				validDays: 7,
			}),
			bearer(owner),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "core.unknown_scope_operation",
		});
	});
});

function workspaceIds(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
	);
}

function operationNames(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `ledger.entry${index}`);
}

describe("the scope of a new API token", () => {
	test.each([
		{
			case: "an operation twice",
			field: "operations",
			scope: {
				operations: ["ledger.readEntries", "ledger.readEntries"],
				workspaces: null,
			},
		},
		{
			case: "a workspace twice",
			field: "workspaces",
			scope: { operations: null, workspaces: [WORKSPACE, WORKSPACE] },
		},
		{
			case: "101 operations",
			field: "operations",
			scope: { operations: operationNames(101), workspaces: null },
		},
		{
			case: "101 workspaces",
			field: "workspaces",
			scope: { operations: null, workspaces: workspaceIds(101) },
		},
	])(
		"is rejected with 400 invalid_input when it names $case",
		async ({ field, scope }) => {
			const api = await startLedgerInstance();
			const owner = await api.issueToken("owner");

			const response = await api.post(
				onInstance("core.createApiToken"),
				JSON.stringify({ ...scope, validDays: 7 }),
				bearer(owner),
			);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				code: "invalid_input",
				issues: [{ path: [field] }],
			});
		},
	);

	test.each(["operations", "workspaces"])(
		"cannot be stored with more than 100 %s",
		async (column) => {
			const api = await startLedgerInstance();
			const owner = await api.issueIdentifiedToken("owner");
			const listed = JSON.stringify(workspaceIds(101));

			const stored = api.database.sql.unsafe(
				`UPDATE core.api_tokens SET ${column} = $1::text::jsonb WHERE id = $2`,
				[listed, owner.apiTokenId],
			);

			await expect(stored).rejects.toThrow(`api_tokens_${column}_check`);
		},
	);
});

describe("an API token scoped to workspaces", () => {
	test("is refused another workspace its actor is a member of with 404 workspace_not_found", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueIdentifiedToken("owner");
		await joinOtherWorkspace(api, owner.serviceAccountId);
		const scoped = await createToken(api, owner.token, {
			operations: null,
			workspaces: [WORKSPACE],
			validDays: 7,
		});

		const inScope = await api.post(
			onWorkspace(WORKSPACE, "ledger.addEntry"),
			"{}",
			bearer(scoped.token),
		);
		const outOfScope = await api.post(
			onWorkspace(OTHER_WORKSPACE, "ledger.addEntry"),
			"{}",
			bearer(scoped.token),
		);

		expect(inScope.status).toBe(200);
		expect(outOfScope.status).toBe(404);
		expect(await outOfScope.json()).toMatchObject({
			code: "workspace_not_found",
		});
	});

	test("is refused an operation on the instance with 403 instance_outside_token_scope", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const scoped = await createToken(api, owner, {
			operations: null,
			workspaces: [WORKSPACE],
			validDays: 7,
		});

		const response = await api.post(
			onInstance("core.listWorkspaces"),
			JSON.stringify({ limit: 10, cursor: null }),
			bearer(scoped.token),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "instance_outside_token_scope",
		});
	});
});

describe("an API token that is revoked or expired", () => {
	test("is rejected with 401 on the next call after its holder revoked it, with the reason revoked_token in the log", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const scoped = await createToken(api, owner, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		const revoked = await api.post(
			onInstance("core.revokeApiToken"),
			JSON.stringify({ id: scoped.id }),
			bearer(owner),
		);

		const response = await api.post(
			onWorkspace(WORKSPACE, "ledger.readEntries"),
			"{}",
			bearer(scoped.token),
		);

		expect(revoked.status).toBe(200);
		expect(await revoked.json()).toEqual({
			id: scoped.id,
			revokedAt: NOW.toISOString(),
		});
		expect(response.status).toBe(401);
		expect(api.logEntries).toContainEqual(
			expect.objectContaining({
				message: "request not authenticated",
				reason: "revoked_token",
			}),
		);
	});

	test("takes every token created with it, and their tokens, down with it when revoked", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const parent = await createToken(api, owner, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		const child = await createToken(api, parent.token, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		const grandchild = await createToken(api, child.token, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		await api.post(
			onInstance("core.revokeApiToken"),
			JSON.stringify({ id: parent.id }),
			bearer(owner),
		);

		const statuses = [];
		for (const token of [child.token, grandchild.token])
			statuses.push(
				(
					await api.post(
						onWorkspace(WORKSPACE, "ledger.readEntries"),
						"{}",
						bearer(token),
					)
				).status,
			);

		expect(statuses).toEqual([401, 401]);
	});

	test("lists the tokens created with a revoked token as revoked", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const parent = await createToken(api, owner, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		const child = await createToken(api, parent.token, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		await api.post(
			onInstance("core.revokeApiToken"),
			JSON.stringify({ id: parent.id }),
			bearer(owner),
		);

		const listed = await api.post(
			onInstance("core.listApiTokens"),
			JSON.stringify({ limit: 10, cursor: null }),
			bearer(owner),
		);

		expect(await listed.json()).toMatchObject({
			apiTokens: expect.arrayContaining([
				expect.objectContaining({
					id: child.id,
					revokedAt: NOW.toISOString(),
				}),
			]),
		});
	});

	test("creates no token once the token of the call was revoked after it was authenticated", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueIdentifiedToken("owner");
		const calling = await createToken(api, owner.token, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		await api.post(
			onInstance("core.revokeApiToken"),
			JSON.stringify({ id: calling.id }),
			bearer(owner.token),
		);

		const created = await api.invoke({
			operation: "core.createApiToken",
			actor: { kind: "service_account", id: owner.serviceAccountId },
			apiToken: {
				id: calling.id,
				expiresAt: IN_A_WEEK,
				scope: { operations: null, workspaces: null },
			},
			idempotencyKey: null,
			workspace: null,
			input: { operations: null, workspaces: null, validDays: 1 },
			correlationId: "revoked-meanwhile",
		});

		expect(created).toMatchObject({
			ok: false,
			failure: { code: "core.calling_token_invalid" },
		});
	});

	test("is rejected with 401 revoked_token when only a token it was created with is marked revoked", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const parent = await createToken(api, owner, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		const child = await createToken(api, parent.token, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		await api.database
			.sql`UPDATE core.api_tokens SET revoked_at = now() WHERE id = ${parent.id}`;

		const response = await api.post(
			onWorkspace(WORKSPACE, "ledger.readEntries"),
			"{}",
			bearer(child.token),
		);

		expect(response.status).toBe(401);
		expect(api.logEntries).toContainEqual(
			expect.objectContaining({
				message: "request not authenticated",
				reason: "revoked_token",
			}),
		);
	});

	test("creates no token once only a token the token of the call was created with is marked revoked", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueIdentifiedToken("owner");
		const parent = await createToken(api, owner.token, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		const child = await createToken(api, parent.token, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		await api.database
			.sql`UPDATE core.api_tokens SET revoked_at = now() WHERE id = ${parent.id}`;

		const created = await api.invoke({
			operation: "core.createApiToken",
			actor: { kind: "service_account", id: owner.serviceAccountId },
			apiToken: {
				id: child.id,
				expiresAt: IN_A_WEEK,
				scope: { operations: null, workspaces: null },
			},
			idempotencyKey: null,
			workspace: null,
			input: { operations: null, workspaces: null, validDays: 1 },
			correlationId: "parent-revoked-meanwhile",
		});

		expect(created).toMatchObject({
			ok: false,
			failure: { code: "core.calling_token_invalid" },
		});
	});

	test("is rejected with 401 once its validity has run out", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const scoped = await createToken(api, owner, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		api.setClock(IN_A_WEEK);

		const response = await api.post(
			onWorkspace(WORKSPACE, "ledger.readEntries"),
			"{}",
			bearer(scoped.token),
		);

		expect(response.status).toBe(401);
	});

	test("cannot be outlived by a token it creates", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const scoped = await createToken(api, owner, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});

		const response = await api.post(
			onInstance("core.createApiToken"),
			JSON.stringify({ operations: null, workspaces: null, validDays: 8 }),
			bearer(scoped.token),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "core.token_scope_exceeded",
		});
	});
});

describe("the API tokens of an actor", () => {
	test("lists only the tokens of the calling actor, the newest first, with scope, expiry and revocation", async () => {
		const api = await startLedgerInstance();
		const alice = await api.issueIdentifiedToken("owner");
		const bob = await api.issueToken("owner");
		const scoped = await createToken(api, alice.token, {
			operations: ["ledger.readEntries"],
			workspaces: [WORKSPACE],
			validDays: 7,
		});
		await createToken(api, bob, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});

		const response = await api.post(
			onInstance("core.listApiTokens"),
			JSON.stringify({ limit: 10, cursor: null }),
			bearer(alice.token),
		);

		expect(await response.json()).toEqual({
			apiTokens: [
				{
					id: scoped.id,
					createdAt: NOW.toISOString(),
					expiresAt: IN_A_WEEK.toISOString(),
					revokedAt: null,
					operations: ["ledger.readEntries"],
					workspaces: [WORKSPACE],
				},
				{
					id: alice.apiTokenId,
					createdAt: NOW.toISOString(),
					expiresAt: "2026-12-26T08:00:00.000Z",
					revokedAt: null,
					operations: null,
					workspaces: null,
				},
			],
			nextCursor: null,
		});
	});

	test("cannot revoke a token of another actor, which keeps working", async () => {
		const api = await startLedgerInstance();
		const alice = await api.issueToken("owner");
		const bob = await api.issueToken("owner");
		const bobs = await createToken(api, bob, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});

		const revoked = await api.post(
			onInstance("core.revokeApiToken"),
			JSON.stringify({ id: bobs.id }),
			bearer(alice),
		);
		const stillWorking = await api.post(
			onWorkspace(WORKSPACE, "ledger.readEntries"),
			"{}",
			bearer(bobs.token),
		);

		expect(revoked.status).toBe(404);
		expect(await revoked.json()).toMatchObject({
			code: "core.api_token_not_found",
		});
		expect(stillWorking.status).toBe(200);
	});

	test("revokes a revoked token again and answers with the time of the first revocation", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const scoped = await createToken(api, owner, {
			operations: null,
			workspaces: null,
			validDays: 7,
		});
		await api.post(
			onInstance("core.revokeApiToken"),
			JSON.stringify({ id: scoped.id }),
			bearer(owner),
		);
		api.setClock(IN_A_WEEK);

		const again = await api.post(
			onInstance("core.revokeApiToken"),
			JSON.stringify({ id: scoped.id }),
			bearer(owner),
		);

		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({
			id: scoped.id,
			revokedAt: NOW.toISOString(),
		});
	});

	test("cannot revoke a token that does not exist", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");

		const revoked = await api.post(
			onInstance("core.revokeApiToken"),
			JSON.stringify({ id: "00000000-0000-4000-8000-00000000dddd" }),
			bearer(owner),
		);

		expect(revoked.status).toBe(404);
		expect(await revoked.json()).toMatchObject({
			code: "core.api_token_not_found",
		});
	});

	test("creates a token with each call even under the same Idempotency-Key and keeps no answer holding it", async () => {
		const api = await startLedgerInstance();
		const owner = await api.issueToken("owner");
		const call = () =>
			api.post(
				onInstance("core.createApiToken"),
				JSON.stringify({ operations: null, workspaces: null, validDays: 7 }),
				{ ...bearer(owner), "Idempotency-Key": "token-1" },
			);

		const first = await createdTokenOf(await call());
		const second = await createdTokenOf(await call());

		expect(second.id).not.toBe(first.id);
		expect(second.token).not.toBe(first.token);
		const stored = JSON.stringify(
			await api.database.sql`SELECT * FROM core.idempotency_keys`,
		);
		expect(stored).not.toContain(first.token);
		expect(stored).not.toContain(second.token);
	});

	test("cannot be created by a user, who holds no API tokens yet", async () => {
		const harness = await startOperationHarness({ plugins: [ledger] });
		harnesses.push(harness);

		const created = await harness.call({
			actor: { kind: "user", id: "alice" },
			workspace: null,
			operation: "core.createApiToken",
			input: { operations: null, workspaces: null, validDays: 7 },
		});

		expect(created).toMatchObject({
			ok: false,
			failure: { code: "core.not_a_service_account", kind: "rejected" },
		});
	});
});
