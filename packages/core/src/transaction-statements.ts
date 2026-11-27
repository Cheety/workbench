import type { Sql } from "@workbench/sdk";
import type { SQL } from "bun";

export function statementsIn(transaction: SQL): Sql {
	return async (strings, ...values) =>
		transaction(strings, ...values).execute();
}
