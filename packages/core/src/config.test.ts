import { describe, expect, test } from "bun:test";
import { InvalidConfigError, loadConfig } from "./config.ts";

const DATABASE_URL =
	"postgres://workbench:s3cr3t-pass@db.internal:5432/workbench";

function noSecretFiles(): string {
	throw new Error("no secret file expected");
}

function captureInvalidConfig(
	env: Record<string, string | undefined>,
	readSecretFile: (path: string) => string = noSecretFiles,
): InvalidConfigError {
	try {
		loadConfig({ env, readSecretFile });
	} catch (error) {
		if (error instanceof InvalidConfigError) return error;
		throw error;
	}
	throw new Error("expected loadConfig to reject the environment");
}

describe("loadConfig", () => {
	test("returns a typed config with defaults when only the required variable is set", () => {
		const config = loadConfig({
			env: { DATABASE_URL },
			readSecretFile: noSecretFiles,
		});

		expect(config.databaseUrl.reveal()).toBe(DATABASE_URL);
		expect(config.port).toBe(3000);
		expect(config.logLevel).toBe("info");
		expect(config.readinessTimeoutMs).toBe(2000);
	});

	test.each([
		["0", "1"],
		["8080", "1500"],
		["65535", "60000"],
	])(
		"reads PORT %s and READINESS_TIMEOUT_MS %s as decimal integers",
		(port, timeout) => {
			const config = loadConfig({
				env: { DATABASE_URL, PORT: port, READINESS_TIMEOUT_MS: timeout },
				readSecretFile: noSecretFiles,
			});

			expect(config.port).toBe(Number(port));
			expect(config.readinessTimeoutMs).toBe(Number(timeout));
		},
	);

	test("rejects a missing required variable and names it", () => {
		const error = captureInvalidConfig({});

		expect(error.issues.map((issue) => issue.variable)).toEqual([
			"DATABASE_URL",
		]);
		expect(error.message).toContain("DATABASE_URL");
	});

	test.each([
		["PORT", "70000"],
		["PORT", "http"],
		["PORT", " "],
		["PORT", "0x1F90"],
		["PORT", "1e3"],
		["PORT", "80.0"],
		["PORT", "+80"],
		["PORT", "080"],
		["PORT", " 80"],
		["READINESS_TIMEOUT_MS", " "],
		["READINESS_TIMEOUT_MS", "0x10"],
		["READINESS_TIMEOUT_MS", "1e3"],
		["LOG_LEVEL", "verbose"],
		["READINESS_TIMEOUT_MS", "0"],
		["DATABASE_URL", "mysql://workbench:s3cr3t-pass@db.internal/workbench"],
		["DATABASE_URL", "s3cr3t-pass"],
		["DATABASE_URL", "postgres:s3cr3t-pass"],
		["DATABASE_URL", "postgres:///s3cr3t-pass"],
	])(
		"rejects invalid %s and names it without echoing the value",
		(variable, value) => {
			const error = captureInvalidConfig({ DATABASE_URL, [variable]: value });

			expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
			expect(error.message).toContain(variable);
			expect(JSON.stringify(error.issues) + error.message).not.toContain(
				"s3cr3t-pass",
			);
		},
	);

	test("reports every rejected variable at once", () => {
		const error = captureInvalidConfig({ PORT: "-1", LOG_LEVEL: "loud" });

		expect(error.issues.map((issue) => issue.variable).sort()).toEqual([
			"DATABASE_URL",
			"LOG_LEVEL",
			"PORT",
		]);
	});

	test("treats an empty variable as unset", () => {
		const config = loadConfig({
			env: { DATABASE_URL, PORT: "", LOG_LEVEL: "" },
			readSecretFile: noSecretFiles,
		});

		expect(config.port).toBe(3000);
		expect(config.logLevel).toBe("info");
	});

	test("reads a secret from the file named by its _FILE variable", () => {
		const config = loadConfig({
			env: { DATABASE_URL_FILE: "/run/secrets/database_url" },
			readSecretFile: (path) => {
				expect(path).toBe("/run/secrets/database_url");
				return `${DATABASE_URL}\n`;
			},
		});

		expect(config.databaseUrl.reveal()).toBe(DATABASE_URL);
	});

	test("rejects a secret given both directly and as a file", () => {
		const error = captureInvalidConfig({
			DATABASE_URL,
			DATABASE_URL_FILE: "/run/secrets/database_url",
		});

		expect(error.issues).toEqual([
			{
				variable: "DATABASE_URL_FILE",
				problem: "must not be set together with DATABASE_URL",
			},
		]);
	});

	test("rejects an unreadable secret file and names the _FILE variable", () => {
		const error = captureInvalidConfig(
			{ DATABASE_URL_FILE: "/run/secrets/missing" },
			() => {
				throw new Error("ENOENT");
			},
		);

		expect(error.message).toContain(
			"DATABASE_URL_FILE names a file that cannot be read",
		);
	});

	test.each([
		["an empty secret file", "\n", "names an empty file"],
		["an invalid secret file", "s3cr3t-pass\n", "must be a postgres"],
	])(
		"rejects %s under the _FILE variable without echoing its content",
		(_case, content, problem) => {
			const error = captureInvalidConfig(
				{ DATABASE_URL_FILE: "/run/secrets/database_url" },
				() => content,
			);

			expect(error.message).toContain(`DATABASE_URL_FILE ${problem}`);
			expect(error.message).not.toContain("s3cr3t-pass");
		},
	);

	test("never exposes a secret through serialization or inspection", () => {
		const config = loadConfig({
			env: { DATABASE_URL },
			readSecretFile: noSecretFiles,
		});

		const rendered = [
			JSON.stringify(config),
			String(config.databaseUrl),
			Bun.inspect(config),
		];

		expect(rendered.join("\n")).not.toContain("s3cr3t-pass");
	});

	test("gives a plugin ten seconds to activate or deactivate unless told otherwise", () => {
		const config = loadConfig({
			env: { DATABASE_URL },
			readSecretFile: noSecretFiles,
		});

		expect(config.pluginHookTimeoutMs).toBe(10_000);
	});

	test.each([
		["1", 1],
		["600000", 600_000],
	])("reads PLUGIN_HOOK_TIMEOUT_MS %s", (value, expected) => {
		const config = loadConfig({
			env: { DATABASE_URL, PLUGIN_HOOK_TIMEOUT_MS: value },
			readSecretFile: noSecretFiles,
		});

		expect(config.pluginHookTimeoutMs).toBe(expected);
	});

	test.each(["0", "600001", "10s", "-1"])(
		"rejects PLUGIN_HOOK_TIMEOUT_MS %s",
		(value) => {
			const error = captureInvalidConfig({
				DATABASE_URL,
				PLUGIN_HOOK_TIMEOUT_MS: value,
			});

			expect(error.issues).toEqual([
				{
					variable: "PLUGIN_HOOK_TIMEOUT_MS",
					problem: "must be a decimal integer between 1 and 600000",
				},
			]);
		},
	);

	test("enables no plugins when PLUGINS is not set", () => {
		const config = loadConfig({
			env: { DATABASE_URL },
			readSecretFile: noSecretFiles,
		});

		expect(config.enabledPlugins).toEqual([]);
	});

	test("reads PLUGINS as a comma-separated list of plugin names", () => {
		const config = loadConfig({
			env: { DATABASE_URL, PLUGINS: "reference, kanban-board,chat2" },
			readSecretFile: noSecretFiles,
		});

		expect(config.enabledPlugins).toEqual([
			"reference",
			"kanban-board",
			"chat2",
		]);
	});

	test.each([
		["an uppercase name", "Reference"],
		["an empty entry", "reference,,chat"],
		["a name with a space", "kanban board"],
		["a package name", "@workbench/plugin-reference"],
	])("rejects PLUGINS with %s", (_case, value) => {
		const error = captureInvalidConfig({ DATABASE_URL, PLUGINS: value });

		expect(error.issues).toEqual([
			{
				variable: "PLUGINS",
				problem:
					"must be a comma-separated list of plugin names (lowercase letters, digits and hyphens, starting with a letter)",
			},
		]);
	});
});
