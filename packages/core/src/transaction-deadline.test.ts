import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { z } from "zod";
import { TEST_DATABASE_URL } from "./testing/postgres.ts";
import { openStatementCancellation } from "./transaction-deadline.ts";

const connectionSettings = z.object({
	sslMode: z.number(),
	tls: z.unknown(),
	query: z.string(),
});

describe("the connection that cancels statements", () => {
	test.each(["disable", "prefer", "require", "verify-ca", "verify-full"])(
		"verifies the server and limits its statements as the pool of the same URL does with sslmode=%s",
		async (mode) => {
			const url = `${TEST_DATABASE_URL}?sslmode=${mode}`;
			const pool = new SQL(url, { connection: { statement_timeout: 60_000 } });
			const cancellation = openStatementCancellation(url, 60_000);

			expect(connectionSettings.parse(cancellation.options)).toEqual(
				connectionSettings.parse(pool.options),
			);
			await cancellation.close();
			await pool.close();
		},
	);
});
