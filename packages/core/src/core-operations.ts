import { listAuditEntries } from "./audit.ts";
import {
	type RegisteredOperation,
	readOperations,
} from "./operation-registry.ts";

export class InvalidCoreOperationsError extends Error {
	constructor(problems: readonly string[]) {
		super(`the operations of the core are invalid: ${problems.join("; ")}`);
		this.name = "InvalidCoreOperationsError";
	}
}

function readCoreOperations(): readonly RegisteredOperation[] {
	const { value, problems } = readOperations({ kind: "core" }, [
		listAuditEntries,
	]);
	if (problems.length > 0) throw new InvalidCoreOperationsError(problems);
	return value;
}

export const CORE_OPERATIONS: readonly RegisteredOperation[] =
	readCoreOperations();
