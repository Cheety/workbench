import { describe, expect, test } from "bun:test";
import {
	assertSupportedPostgresVersion,
	UnsupportedPostgresVersionError,
} from "./postgres.ts";

describe("supported Postgres version", () => {
	test.each([170000, 170002, 179999])(
		"accepts a server reporting server_version_num %d",
		(serverVersionNum) => {
			expect(() =>
				assertSupportedPostgresVersion(serverVersionNum),
			).not.toThrow();
		},
	);

	test.each([
		[160004, 16],
		[169999, 16],
		[180000, 18],
		[90624, 9],
	])(
		"rejects a server reporting server_version_num %d as Postgres %d",
		(serverVersionNum, major) => {
			const assert = () => assertSupportedPostgresVersion(serverVersionNum);

			expect(assert).toThrow(UnsupportedPostgresVersionError);
			expect(assert).toThrow(
				`test database runs Postgres ${major} (server_version_num ${serverVersionNum}), tests need Postgres 17 as in production`,
			);
		},
	);
});
