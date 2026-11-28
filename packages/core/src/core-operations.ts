import { auditRead, listAuditEntries } from "./audit.ts";
import {
	type RegisteredOperation,
	readOperations,
} from "./operation-registry.ts";
import { CORE_OWNER } from "./owner.ts";
import { readRights } from "./rights.ts";

export class InvalidCoreOperationsError extends Error {
	constructor(problems: readonly string[]) {
		super(`the operations of the core are invalid: ${problems.join("; ")}`);
		this.name = "InvalidCoreOperationsError";
	}
}

function readCoreOperations(): readonly RegisteredOperation[] {
	const rights = readRights(CORE_OWNER, [auditRead]);
	const operations = readOperations(
		CORE_OWNER,
		[listAuditEntries],
		rights.value,
	);
	const problems = [...rights.problems, ...operations.problems];
	if (problems.length > 0) throw new InvalidCoreOperationsError(problems);
	return operations.value;
}

export const CORE_OPERATIONS: readonly RegisteredOperation[] =
	readCoreOperations();
