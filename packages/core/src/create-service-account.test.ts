import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { authenticateToken } from "./api-tokens.ts";
import { createFreshDatabase, type FreshDatabase } from "./testing/postgres.ts";

const COMMAND = new URL("./create-service-account.ts", import.meta.url)
	.pathname;

const databases: FreshDatabase[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) await database.drop();
});

async function freshDatabase(): Promise<FreshDatabase> {
	const database = await createFreshDatabase();
	databases.push(database);
	return database;
}

async function runCommand(databaseUrl: string, args: readonly string[]) {
	const command = Bun.spawn([process.execPath, COMMAND, ...args], {
		env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		command.exited,
		new Response(command.stdout).text(),
		new Response(command.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

const issuedToken = z.object({
	serviceAccount: z.string(),
	token: z.string(),
	expiresAt: z.iso.datetime(),
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const issued = (stdout: string) => issuedToken.parse(JSON.parse(stdout));

describe("creating a service account by command", () => {
	test("prints the token once and stores only its hash", async () => {
		const database = await freshDatabase();
		const before = Date.now();

		const run = await runCommand(database.url, [
			"--name",
			"deploy agent",
			"--valid-days",
			"30",
		]);

		const after = Date.now();
		expect(run.exitCode).toBe(0);
		const { serviceAccount, token, expiresAt } = issued(run.stdout);
		expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(
			before + THIRTY_DAYS_MS,
		);
		expect(Date.parse(expiresAt)).toBeLessThanOrEqual(after + THIRTY_DAYS_MS);
		expect(token).toMatch(/^wbt_[A-Za-z0-9_-]{43}$/);
		expect(run.stderr).not.toContain(token);
		const stored = JSON.stringify(
			await database.sql`SELECT * FROM core.api_tokens`,
		);
		expect(stored).not.toContain(token);
		expect(stored).not.toContain(token.slice(4));
		expect(
			await authenticateToken(database.sql, token, new Date(expiresAt)),
		).toEqual({ authenticated: false, reason: "expired_token" });
		expect(
			await authenticateToken(
				database.sql,
				token,
				new Date(Date.parse(expiresAt) - 1),
			),
		).toEqual({
			authenticated: true,
			actor: { kind: "service_account", id: serviceAccount },
		});
	});

	test.each([
		{ case: "no name", args: ["--valid-days", "30"] },
		{ case: "no validity", args: ["--name", "agent"] },
		{
			case: "a validity of zero days",
			args: ["--name", "agent", "--valid-days", "0"],
		},
		{
			case: "a validity above 3650 days",
			args: ["--name", "agent", "--valid-days", "3651"],
		},
		{
			case: "an unknown option",
			args: ["--name", "agent", "--valid-days", "30", "--admin"],
		},
	])(
		"aborts with exit code 1 and the usage when given $case",
		async ({ args }) => {
			const database = await freshDatabase();

			const run = await runCommand(database.url, args);

			expect(run.exitCode).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("usage: create-service-account");
		},
	);
});
