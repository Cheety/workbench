import { afterEach, describe, expect, test } from "bun:test";
import { type Actor, defineOperation, definePlugin } from "@workbench/sdk";
import { z } from "zod";
import {
	type OperationHarness,
	type PluginPackage,
	startOperationHarness,
} from "./testing/operation-harness.ts";

const ADMIN: Actor = { kind: "service_account", id: "admin" };

const ALICE: Actor = { kind: "user", id: "alice" };

const BOB: Actor = { kind: "user", id: "bob" };

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
				{ name: "ledger.entry.read", defaultRoles: ["owner", "editor"] },
			],
			operations: [addEntry, readEntries],
		}),
};

const harnesses: OperationHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.stop();
});

async function startLedger(): Promise<OperationHarness> {
	const harness = await startOperationHarness({
		plugins: [ledger],
		instanceAdmins: [ADMIN],
	});
	harnesses.push(harness);
	return harness;
}

const createdWorkspace = z.object({
	ok: z.literal(true),
	output: z.object({ id: z.string(), name: z.string() }),
});

async function createWorkspaceAsAdmin(
	harness: OperationHarness,
	name: string,
): Promise<string> {
	const created = await harness.call({
		actor: ADMIN,
		workspace: null,
		operation: "core.createWorkspace",
		input: { name },
	});
	return createdWorkspace.parse(created).output.id;
}

async function grant(
	harness: OperationHarness,
	workspace: string,
	actor: Actor,
	role: string,
): Promise<unknown> {
	return harness.call({
		actor: ADMIN,
		workspace,
		operation: "core.grantMembership",
		input: { actor, role },
	});
}

function listWorkspacesOf(
	harness: OperationHarness,
	actor: Actor,
): Promise<unknown> {
	return harness.call({
		actor,
		workspace: null,
		operation: "core.listWorkspaces",
		input: { limit: 100, cursor: null },
	});
}

describe("administering workspaces", () => {
	test("lets an instance admin create a workspace and grant a membership, after which the member lists it", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await grant(harness, workspace, ALICE, "editor");

		const listed = await listWorkspacesOf(harness, ALICE);

		expect(listed).toEqual({
			ok: true,
			output: {
				workspaces: [{ id: workspace, name: "Accounts", role: "editor" }],
				nextCursor: null,
			},
		});
	});

	test("lists only the workspaces in which the actor has a membership, sorted by name", async () => {
		const harness = await startLedger();
		const zeta = await createWorkspaceAsAdmin(harness, "Zeta");
		const alpha = await createWorkspaceAsAdmin(harness, "Alpha");
		const foreign = await createWorkspaceAsAdmin(harness, "Foreign");
		await grant(harness, zeta, ALICE, "viewer");
		await grant(harness, alpha, ALICE, "owner");
		await grant(harness, foreign, BOB, "owner");

		const listed = await listWorkspacesOf(harness, ALICE);

		expect(listed).toEqual({
			ok: true,
			output: {
				workspaces: [
					{ id: alpha, name: "Alpha", role: "owner" },
					{ id: zeta, name: "Zeta", role: "viewer" },
				],
				nextCursor: null,
			},
		});
	});

	test("pages the list of workspaces by its cursor", async () => {
		const harness = await startLedger();
		const first = await createWorkspaceAsAdmin(harness, "Alpha");
		const second = await createWorkspaceAsAdmin(harness, "Beta");
		await grant(harness, first, ALICE, "owner");
		await grant(harness, second, ALICE, "owner");
		const page = z
			.object({ output: z.object({ nextCursor: z.string() }) })
			.parse(
				await harness.call({
					actor: ALICE,
					workspace: null,
					operation: "core.listWorkspaces",
					input: { limit: 1, cursor: null },
				}),
			);

		const next = await harness.call({
			actor: ALICE,
			workspace: null,
			operation: "core.listWorkspaces",
			input: { limit: 1, cursor: page.output.nextCursor },
		});

		expect(next).toEqual({
			ok: true,
			output: {
				workspaces: [{ id: second, name: "Beta", role: "owner" }],
				nextCursor: null,
			},
		});
	});

	test("rejects a cursor that names no position in the list of workspaces", async () => {
		const harness = await startLedger();

		const listed = await harness.call({
			actor: ALICE,
			workspace: null,
			operation: "core.listWorkspaces",
			input: { limit: 10, cursor: "bm8tcG9zaXRpb24" },
		});

		expect(listed).toEqual({
			ok: false,
			failure: {
				code: "core.invalid_cursor",
				kind: "rejected",
				detail: "the cursor does not name a position in the list of workspaces",
				issues: [],
			},
		});
	});

	test("hides a workspace again once the membership is revoked", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await grant(harness, workspace, ALICE, "editor");
		await harness.call({
			actor: ADMIN,
			workspace,
			operation: "core.revokeMembership",
			input: { actor: ALICE },
		});

		const read = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.readEntries",
			input: {},
		});

		expect(read).toMatchObject({
			ok: false,
			failure: { code: "workspace_not_found" },
		});
		expect(await listWorkspacesOf(harness, ALICE)).toEqual({
			ok: true,
			output: { workspaces: [], nextCursor: null },
		});
	});

	test("changes the role of an existing membership when it is granted again", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await grant(harness, workspace, ALICE, "editor");
		await grant(harness, workspace, ALICE, "viewer");

		const added = await harness.call({
			actor: ALICE,
			workspace,
			operation: "ledger.addEntry",
			input: {},
		});

		expect(added).toMatchObject({
			ok: false,
			failure: { code: "missing_right" },
		});
	});

	test("rejects a membership with a role nobody defined", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");

		const granted = await grant(harness, workspace, ALICE, "auditor");

		expect(granted).toMatchObject({
			ok: false,
			failure: { code: "core.unknown_role", kind: "not_found" },
		});
	});
});

function defineRoleAsAdmin(
	harness: OperationHarness,
	name: string,
	rights: readonly string[],
): Promise<unknown> {
	return harness.call({
		actor: ADMIN,
		workspace: null,
		operation: "core.defineRole",
		input: { name, rights },
	});
}

function callLedger(
	harness: OperationHarness,
	workspace: string,
	operation: string,
): Promise<unknown> {
	return harness.call({ actor: ALICE, workspace, operation, input: {} });
}

describe("a custom role", () => {
	test("grants exactly the rights it was defined with", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await defineRoleAsAdmin(harness, "auditor", ["ledger.entry.read"]);
		await grant(harness, workspace, ALICE, "auditor");

		const read = await callLedger(harness, workspace, "ledger.readEntries");
		const added = await callLedger(harness, workspace, "ledger.addEntry");

		expect(read).toEqual({ ok: true, output: { read: true } });
		expect(added).toMatchObject({
			ok: false,
			failure: { code: "missing_right" },
		});
	});

	test("grants the rights of its latest definition", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await defineRoleAsAdmin(harness, "clerk", ["ledger.entry.read"]);
		await defineRoleAsAdmin(harness, "clerk", ["ledger.entry.add"]);
		await grant(harness, workspace, ALICE, "clerk");

		const read = await callLedger(harness, workspace, "ledger.readEntries");
		const added = await callLedger(harness, workspace, "ledger.addEntry");

		expect(read).toMatchObject({
			ok: false,
			failure: { code: "missing_right" },
		});
		expect(added).toEqual({ ok: true, output: { added: true } });
	});

	test("lets its member read the audit of the workspace when it grants core.audit.read", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await defineRoleAsAdmin(harness, "auditor", ["core.audit.read"]);
		await grant(harness, workspace, ALICE, "auditor");

		const audit = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.listAuditEntries",
			input: { limit: 10, cursor: null },
		});

		expect(auditPage.parse(audit).output.entries).toEqual([
			expect.objectContaining({
				operation: "core.grantMembership",
				workspace,
				result: "succeeded",
			}),
		]);
	});

	test.each([
		{
			case: "a right that no operation grants through a role",
			name: "auditor",
			rights: ["ledger.entry.purge"],
			code: "core.unknown_right",
		},
		{
			case: "a right only an instance admin holds",
			name: "auditor",
			rights: ["core.workspace.create"],
			code: "core.unknown_right",
		},
		{
			case: "the name of a start role",
			name: "viewer",
			rights: ["ledger.entry.add"],
			code: "core.start_role_not_definable",
		},
	])("is not defined with $case", async ({ name, rights, code }) => {
		const harness = await startLedger();

		const defined = await defineRoleAsAdmin(harness, name, rights);

		expect(defined).toMatchObject({
			ok: false,
			failure: { code, kind: "rejected" },
		});
	});
});

describe("an actor who is no instance admin", () => {
	test.each([
		{
			case: "create a workspace",
			operation: "core.createWorkspace",
			input: { name: "Accounts" },
		},
		{
			case: "define a role",
			operation: "core.defineRole",
			input: { name: "auditor", rights: [] },
		},
		{
			case: "read the audit of the instance",
			operation: "core.listInstanceAuditEntries",
			input: { limit: 10, cursor: null },
		},
	])("may not $case", async ({ operation, input }) => {
		const harness = await startLedger();

		const called = await harness.call({
			actor: ALICE,
			workspace: null,
			operation,
			input,
		});

		expect(called).toEqual({
			ok: false,
			failure: {
				code: "not_instance_admin",
				kind: "forbidden",
				detail: "only an instance admin may call the operation",
				issues: [],
			},
		});
	});

	test("may not grant a membership, even as owner of the workspace", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await grant(harness, workspace, ALICE, "owner");

		const granted = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.grantMembership",
			input: { actor: BOB, role: "owner" },
		});

		expect(granted).toMatchObject({
			ok: false,
			failure: { code: "not_instance_admin" },
		});
		expect(await listWorkspacesOf(harness, BOB)).toEqual({
			ok: true,
			output: { workspaces: [], nextCursor: null },
		});
	});

	test("may not revoke a membership, even as owner of the workspace", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await grant(harness, workspace, ALICE, "owner");
		await grant(harness, workspace, BOB, "editor");

		const revoked = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.revokeMembership",
			input: { actor: BOB },
		});

		expect(revoked).toMatchObject({
			ok: false,
			failure: { code: "not_instance_admin", kind: "forbidden" },
		});
		expect(await listWorkspacesOf(harness, BOB)).toEqual({
			ok: true,
			output: {
				workspaces: [{ id: workspace, name: "Accounts", role: "editor" }],
				nextCursor: null,
			},
		});
	});

	test("learns nothing about a workspace without a membership when granting in it", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");

		const granted = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.grantMembership",
			input: { actor: ALICE, role: "owner" },
		});

		expect(granted).toMatchObject({
			ok: false,
			failure: { code: "workspace_not_found" },
		});
	});
});

const auditPage = z.object({
	ok: z.literal(true),
	output: z.object({
		entries: z.array(
			z.object({
				operation: z.string(),
				workspace: z.string().nullable(),
				actor: z.object({ kind: z.string(), id: z.string() }),
				result: z.string(),
				reason: z.string().optional(),
			}),
		),
	}),
});

function instanceAuditOf(harness: OperationHarness): Promise<unknown> {
	return harness.call({
		actor: ADMIN,
		workspace: null,
		operation: "core.listInstanceAuditEntries",
		input: { limit: 10, cursor: null },
	});
}

describe("the audit of administering workspaces", () => {
	test("names each creation of a workspace, definition of a role and change of a membership", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await defineRoleAsAdmin(harness, "auditor", ["ledger.entry.read"]);
		await grant(harness, workspace, ALICE, "auditor");
		await harness.call({
			actor: ADMIN,
			workspace,
			operation: "core.revokeMembership",
			input: { actor: ALICE },
		});

		const audit = await instanceAuditOf(harness);

		expect(audit).toEqual({
			ok: true,
			output: {
				entries: [
					{
						id: "00000000-0000-4000-a000-000000000004",
						occurredAt: "2026-11-26T08:00:00.000Z",
						actor: ADMIN,
						apiTokenId: null,
						operation: "core.revokeMembership",
						workspace,
						result: "succeeded",
						member: ALICE,
						role: "auditor",
					},
					{
						id: "00000000-0000-4000-a000-000000000003",
						occurredAt: "2026-11-26T08:00:00.000Z",
						actor: ADMIN,
						apiTokenId: null,
						operation: "core.grantMembership",
						workspace,
						result: "succeeded",
						member: ALICE,
						role: "auditor",
					},
					{
						id: "00000000-0000-4000-a000-000000000002",
						occurredAt: "2026-11-26T08:00:00.000Z",
						actor: ADMIN,
						apiTokenId: null,
						operation: "core.defineRole",
						workspace: null,
						result: "succeeded",
						member: null,
						role: "auditor",
					},
					{
						id: "00000000-0000-4000-a000-000000000001",
						occurredAt: "2026-11-26T08:00:00.000Z",
						actor: ADMIN,
						apiTokenId: null,
						operation: "core.createWorkspace",
						workspace: null,
						result: "succeeded",
						member: null,
						role: null,
					},
				],
				nextCursor: null,
			},
		});
	});

	test("names the member but no role when a revoked membership did not exist", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		const revoked = await harness.call({
			actor: ADMIN,
			workspace,
			operation: "core.revokeMembership",
			input: { actor: BOB },
		});

		const audit = await instanceAuditOf(harness);

		expect(revoked).toEqual({
			ok: true,
			output: { revoked: false, role: null },
		});
		expect(audit).toMatchObject({
			ok: true,
			output: {
				entries: [
					{
						operation: "core.revokeMembership",
						member: BOB,
						role: null,
					},
					{ operation: "core.createWorkspace" },
				],
			},
		});
	});

	test("names the member and the role of a changed membership to the owners of the workspace", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await grant(harness, workspace, ALICE, "owner");
		await grant(harness, workspace, BOB, "viewer");

		const audit = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.listAuditEntries",
			input: { limit: 1, cursor: null },
		});

		expect(audit).toMatchObject({
			ok: true,
			output: {
				entries: [
					{
						operation: "core.grantMembership",
						member: BOB,
						role: "viewer",
					},
				],
			},
		});
	});

	test("shows the owners of a workspace who changed its memberships", async () => {
		const harness = await startLedger();
		const workspace = await createWorkspaceAsAdmin(harness, "Accounts");
		await grant(harness, workspace, ALICE, "owner");

		const audit = await harness.call({
			actor: ALICE,
			workspace,
			operation: "core.listAuditEntries",
			input: { limit: 10, cursor: null },
		});

		expect(auditPage.parse(audit).output.entries).toEqual([
			expect.objectContaining({
				operation: "core.grantMembership",
				workspace,
				actor: ADMIN,
				result: "succeeded",
			}),
		]);
	});

	test("names a denied attempt to create a workspace", async () => {
		const harness = await startLedger();
		await harness.call({
			actor: ALICE,
			workspace: null,
			operation: "core.createWorkspace",
			input: { name: "Accounts" },
		});

		const audit = await instanceAuditOf(harness);

		expect(auditPage.parse(audit).output.entries).toEqual([
			expect.objectContaining({
				operation: "core.createWorkspace",
				workspace: null,
				actor: ALICE,
				result: "denied",
				reason: "not_instance_admin",
			}),
		]);
	});

	test("keeps one denied attempt on the instance per actor, operation and minute", async () => {
		const harness = await startLedger();
		for (const name of ["Accounts", "Finance"])
			await harness.call({
				actor: ALICE,
				workspace: null,
				operation: "core.createWorkspace",
				input: { name },
			});

		const audit = await instanceAuditOf(harness);

		expect(auditPage.parse(audit).output.entries).toHaveLength(1);
	});
});
