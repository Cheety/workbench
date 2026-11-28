import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CliConfigSource,
	InvalidCliConfigError,
	InvalidConfigError,
	loadCliConfig,
	loadConfig,
} from "./config.ts";

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
		["0", 0, "1", 1],
		["8080", 8080, "1500", 1500],
		["65535", 65535, "60000", 60000],
	])(
		"reads PORT %s as %d and READINESS_TIMEOUT_MS %s as %d",
		(port, expectedPort, timeout, expectedTimeoutMs) => {
			const config = loadConfig({
				env: { DATABASE_URL, PORT: port, READINESS_TIMEOUT_MS: timeout },
				readSecretFile: noSecretFiles,
			});

			expect(config.port).toBe(expectedPort);
			expect(config.readinessTimeoutMs).toBe(expectedTimeoutMs);
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
		["PORT", "0x1F90"],
		["PORT", "1e3"],
		["PORT", "80.0"],
		["PORT", "+80"],
		["PORT", "080"],
		["PORT", " 80"],
		["READINESS_TIMEOUT_MS", "0x10"],
		["READINESS_TIMEOUT_MS", "1e3"],
		["READINESS_TIMEOUT_MS", "70000"],
		["LOG_LEVEL", "verbose"],
	])(
		"rejects %s set to %j and names it without echoing the value",
		(variable, value) => {
			const error = captureInvalidConfig({ DATABASE_URL, [variable]: value });

			expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
			expect(error.message).toContain(variable);
			expect(JSON.stringify(error.issues) + error.message).not.toContain(value);
		},
	);

	test.each([
		["PORT", " "],
		["READINESS_TIMEOUT_MS", " "],
		["READINESS_TIMEOUT_MS", "0"],
	])("rejects %s set to %j and names it", (variable, value) => {
		const error = captureInvalidConfig({ DATABASE_URL, [variable]: value });

		expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
		expect(error.message).toContain(variable);
	});

	test.each([
		"mysql://workbench:s3cr3t-pass@db.internal/workbench",
		"s3cr3t-pass",
		"postgres:s3cr3t-pass",
		"postgres:///s3cr3t-pass",
	])(
		"rejects DATABASE_URL set to %j and names it without echoing its password",
		(value) => {
			const error = captureInvalidConfig({ DATABASE_URL: value });

			expect(error.issues.map((issue) => issue.variable)).toEqual([
				"DATABASE_URL",
			]);
			expect(error.message).toContain("DATABASE_URL");
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

	test("names no instance admin when INSTANCE_ADMIN_SERVICE_ACCOUNTS is not set", () => {
		const config = loadConfig({
			env: { DATABASE_URL },
			readSecretFile: noSecretFiles,
		});

		expect(config.instanceAdmins).toEqual([]);
	});

	test.each([
		["empty", ""],
		["blank", "  "],
	])(
		"names no instance admin when INSTANCE_ADMIN_SERVICE_ACCOUNTS is %s",
		(_case, value) => {
			const config = loadConfig({
				env: { DATABASE_URL, INSTANCE_ADMIN_SERVICE_ACCOUNTS: value },
				readSecretFile: noSecretFiles,
			});

			expect(config.instanceAdmins).toEqual([]);
		},
	);

	test("reads INSTANCE_ADMIN_SERVICE_ACCOUNTS as service accounts that are instance admins", () => {
		const config = loadConfig({
			env: {
				DATABASE_URL,
				INSTANCE_ADMIN_SERVICE_ACCOUNTS:
					"7d4b8c1e-2f3a-4b5c-8d6e-9f0a1b2c3d4e, 51c2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b",
			},
			readSecretFile: noSecretFiles,
		});

		expect(config.instanceAdmins).toEqual([
			{ kind: "service_account", id: "7d4b8c1e-2f3a-4b5c-8d6e-9f0a1b2c3d4e" },
			{ kind: "service_account", id: "51c2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b" },
		]);
	});

	test.each([
		["a name instead of an ID", "admin"],
		["an empty entry", "7d4b8c1e-2f3a-4b5c-8d6e-9f0a1b2c3d4e,,"],
	])("rejects INSTANCE_ADMIN_SERVICE_ACCOUNTS with %s", (_case, value) => {
		const error = captureInvalidConfig({
			DATABASE_URL,
			INSTANCE_ADMIN_SERVICE_ACCOUNTS: value,
		});

		expect(error.issues).toEqual([
			{
				variable: "INSTANCE_ADMIN_SERVICE_ACCOUNTS",
				problem:
					"must be a comma-separated list of service account IDs (UUIDs)",
			},
		]);
	});
});

const TOKEN = "wbt_s3cr3t-token";

function filesOf(
	files: Readonly<Record<string, string>>,
): CliConfigSource["readFile"] {
	return (path) => {
		const text = files[path];
		return text === undefined ? { found: "missing" } : { found: "text", text };
	};
}

function captureInvalidCliConfig(
	source: CliConfigSource,
): InvalidCliConfigError {
	try {
		loadCliConfig(source);
	} catch (error) {
		if (error instanceof InvalidCliConfigError) return error;
		throw error;
	}
	throw new Error("expected loadCliConfig to reject the configuration");
}

describe("loadCliConfig", () => {
	test("reads the configuration file under XDG_CONFIG_HOME before the one under HOME", () => {
		const config = loadCliConfig({
			env: { XDG_CONFIG_HOME: "/config", HOME: "/home/ada" },
			readFile: filesOf({
				"/config/workbench/cli.json": JSON.stringify({
					url: "https://workbench.example",
					token: TOKEN,
				}),
				"/home/ada/.config/workbench/cli.json": JSON.stringify({
					url: "https://other.example",
					token: "wbt_other",
				}),
			}),
		});

		expect(config.instanceUrl.href).toBe("https://workbench.example/");
		expect(config.token.reveal()).toBe(TOKEN);
	});

	test("rejects a WORKBENCH_CONFIG that names a missing file", () => {
		const error = captureInvalidCliConfig({
			env: { WORKBENCH_CONFIG: "/nowhere.json", WORKBENCH_TOKEN: TOKEN },
			readFile: filesOf({}),
		});

		expect(error.issues).toEqual([
			{
				subject: "WORKBENCH_CONFIG",
				problem: "names a file that does not exist",
			},
		]);
	});

	test.each([
		["not JSON", "token = wbt_s3cr3t-token"],
		["an unknown field", JSON.stringify({ token: TOKEN, user: "ada" })],
		["a token that is not a string", JSON.stringify({ token: 42 })],
	])(
		"rejects a configuration file with %s and names the file, not its content",
		(_case, content) => {
			const error = captureInvalidCliConfig({
				env: { HOME: "/home/ada" },
				readFile: filesOf({ "/home/ada/.config/workbench/cli.json": content }),
			});

			expect(error.issues).toEqual([
				{
					subject: "/home/ada/.config/workbench/cli.json",
					problem:
						"must be a JSON object with no other fields than the strings url and token",
				},
			]);
			expect(error.message).not.toContain(TOKEN);
		},
	);

	test("rejects a URL that is not http or https and names where it came from, not the URL", () => {
		const error = captureInvalidCliConfig({
			env: { HOME: "/home/ada", WORKBENCH_TOKEN: TOKEN },
			readFile: filesOf({
				"/home/ada/.config/workbench/cli.json": JSON.stringify({
					url: "ftp://workbench.example",
				}),
			}),
		});

		expect(error.issues).toEqual([
			{
				subject: "url in /home/ada/.config/workbench/cli.json",
				problem: "must be a http:// or https:// URL with a host",
			},
		]);
	});

	test.each([
		{
			case: "a line break in WORKBENCH_TOKEN",
			env: { WORKBENCH_TOKEN: `${TOKEN}\n` },
			file: {},
			subject: "WORKBENCH_TOKEN",
		},
		{
			case: "a space in WORKBENCH_TOKEN",
			env: { WORKBENCH_TOKEN: `Bearer ${TOKEN}` },
			file: {},
			subject: "WORKBENCH_TOKEN",
		},
		{
			case: "a character beyond ASCII in the token of the file",
			env: {},
			file: { token: `${TOKEN}\u20ac` },
			subject: "token in /home/ada/.config/workbench/cli.json",
		},
	])(
		"rejects a token that cannot be sent as a bearer token in an HTTP header, with $case, and names its source, not the token",
		({ env, file, subject }) => {
			const error = captureInvalidCliConfig({
				env: {
					HOME: "/home/ada",
					WORKBENCH_URL: "http://127.0.0.1:3000",
					...env,
				},
				readFile: filesOf({
					"/home/ada/.config/workbench/cli.json": JSON.stringify(file),
				}),
			});

			expect(error.issues).toEqual([
				{
					subject,
					problem: "must consist of visible ASCII characters only",
				},
			]);
			expect(error.message).not.toContain(TOKEN);
		},
	);

	test("names only the variables when neither HOME nor XDG_CONFIG_HOME is set", () => {
		const error = captureInvalidCliConfig({ env: {}, readFile: filesOf({}) });

		expect(error.issues).toEqual([
			{ subject: "WORKBENCH_URL", problem: "is required" },
			{ subject: "WORKBENCH_TOKEN", problem: "is required" },
		]);
	});

	test("keeps the token out of its text", () => {
		const config = loadCliConfig({
			env: { WORKBENCH_URL: "http://127.0.0.1:3000", WORKBENCH_TOKEN: TOKEN },
			readFile: filesOf({}),
		});

		expect(JSON.stringify(config)).not.toContain(TOKEN);
	});
});

const CONFIG_MODULE = new URL("./config.ts", import.meta.url).pathname;

const LOADING_FROM_THE_ENVIRONMENT = `
import { InvalidCliConfigError, loadCliConfigFromEnvironment } from ${JSON.stringify(CONFIG_MODULE)};
try {
	const config = loadCliConfigFromEnvironment();
	console.log(JSON.stringify({ instanceUrl: config.instanceUrl.href, token: config.token.reveal() }));
} catch (error) {
	if (!(error instanceof InvalidCliConfigError)) throw error;
	console.log(JSON.stringify({ issues: error.issues }));
}
`;

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function emptyDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "workbench-config-"));
	directories.push(directory);
	return directory;
}

async function homeWithConfigFile(content: unknown): Promise<string> {
	const home = await emptyDirectory();
	await mkdir(join(home, ".config", "workbench"), { recursive: true });
	await writeFile(
		join(home, ".config", "workbench", "cli.json"),
		JSON.stringify(content),
	);
	return home;
}

async function loadedFromEnvironment(
	env: Readonly<Record<string, string>>,
): Promise<unknown> {
	const loading = Bun.spawn(
		[process.execPath, "--eval", LOADING_FROM_THE_ENVIRONMENT],
		{ env, stdout: "pipe", stderr: "inherit" },
	);
	const [exitCode, stdout] = await Promise.all([
		loading.exited,
		new Response(loading.stdout).text(),
	]);
	expect(exitCode).toBe(0);
	return JSON.parse(stdout);
}

describe("loadCliConfigFromEnvironment", () => {
	test("reads the configuration file under HOME when XDG_CONFIG_HOME is empty", async () => {
		const home = await homeWithConfigFile({
			url: "https://workbench.example",
			token: TOKEN,
		});

		const loaded = await loadedFromEnvironment({
			XDG_CONFIG_HOME: "",
			HOME: home,
		});

		expect(loaded).toEqual({
			instanceUrl: "https://workbench.example/",
			token: TOKEN,
		});
	});

	test("takes a configuration file missing under XDG_CONFIG_HOME as none, without falling back to HOME", async () => {
		const configHome = await emptyDirectory();
		const home = await homeWithConfigFile({
			url: "https://workbench.example",
			token: TOKEN,
		});
		const path = join(configHome, "workbench", "cli.json");

		const loaded = await loadedFromEnvironment({
			XDG_CONFIG_HOME: configHome,
			HOME: home,
		});

		expect(loaded).toEqual({
			issues: [
				{ subject: `WORKBENCH_URL, or url in ${path}`, problem: "is required" },
				{
					subject: `WORKBENCH_TOKEN, or token in ${path}`,
					problem: "is required",
				},
			],
		});
	});

	test("rejects a WORKBENCH_CONFIG that names a path where no file exists", async () => {
		const directory = await emptyDirectory();

		const loaded = await loadedFromEnvironment({
			WORKBENCH_CONFIG: join(directory, "cli.json"),
			WORKBENCH_TOKEN: TOKEN,
		});

		expect(loaded).toEqual({
			issues: [
				{
					subject: "WORKBENCH_CONFIG",
					problem: "names a file that does not exist",
				},
			],
		});
	});

	test("rejects a WORKBENCH_CONFIG that names a directory as a file that cannot be read", async () => {
		const directory = await emptyDirectory();

		const loaded = await loadedFromEnvironment({
			WORKBENCH_CONFIG: directory,
			WORKBENCH_TOKEN: TOKEN,
		});

		expect(loaded).toEqual({
			issues: [{ subject: directory, problem: "cannot be read" }],
		});
	});
});
