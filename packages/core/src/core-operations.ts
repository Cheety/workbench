import {
	apiTokenManage,
	createApiTokenOperation,
	listApiTokensOperation,
	revokeApiTokenOperation,
} from "./api-token-operations.ts";
import {
	auditRead,
	instanceAuditRead,
	listAuditEntries,
	listInstanceAuditEntries,
} from "./audit.ts";
import {
	grantMembershipOperation,
	membershipManage,
	revokeMembershipOperation,
} from "./memberships.ts";
import {
	instanceAdminWorkspaceOperationOf,
	instanceOperationOf,
	type RegisteredOperation,
	readOperations,
	withoutIdempotencyKey,
} from "./operation-registry.ts";
import { CORE_OWNER } from "./owner.ts";
import { readRights } from "./rights.ts";
import { defineRoleOperation, roleDefine } from "./roles.ts";
import {
	createWorkspaceOperation,
	listWorkspacesOperation,
	workspaceCreate,
	workspaceList,
} from "./workspaces.ts";

export class InvalidCoreOperationsError extends Error {
	constructor(problems: readonly string[]) {
		super(`the operations of the core are invalid: ${problems.join("; ")}`);
		this.name = "InvalidCoreOperationsError";
	}
}

const INSTANCE_ADMIN = { by: "instance_admin" } as const;

const EVERY_ACTOR = { by: "every_actor" } as const;

function readCoreOperations(): readonly RegisteredOperation[] {
	const rights = readRights(CORE_OWNER, [
		apiTokenManage,
		auditRead,
		instanceAuditRead,
		membershipManage,
		roleDefine,
		workspaceCreate,
		workspaceList,
	]);
	const grantedByRole = readOperations(
		CORE_OWNER,
		[listAuditEntries],
		rights.value,
	);
	const problems = [...rights.problems, ...grantedByRole.problems];
	if (problems.length > 0) throw new InvalidCoreOperationsError(problems);
	return [
		...grantedByRole.value,
		instanceAdminWorkspaceOperationOf(CORE_OWNER, grantMembershipOperation),
		instanceAdminWorkspaceOperationOf(CORE_OWNER, revokeMembershipOperation),
		instanceOperationOf(CORE_OWNER, createWorkspaceOperation, INSTANCE_ADMIN),
		instanceOperationOf(CORE_OWNER, defineRoleOperation, INSTANCE_ADMIN),
		instanceOperationOf(CORE_OWNER, listInstanceAuditEntries, INSTANCE_ADMIN),
		instanceOperationOf(CORE_OWNER, listWorkspacesOperation, EVERY_ACTOR),
		withoutIdempotencyKey(
			instanceOperationOf(CORE_OWNER, createApiTokenOperation, EVERY_ACTOR),
		),
		instanceOperationOf(CORE_OWNER, listApiTokensOperation, EVERY_ACTOR),
		instanceOperationOf(CORE_OWNER, revokeApiTokenOperation, EVERY_ACTOR),
	];
}

export const CORE_OPERATIONS: readonly RegisteredOperation[] =
	readCoreOperations();
