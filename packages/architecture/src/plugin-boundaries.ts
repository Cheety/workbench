import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type PluginBoundaryViolation = {
	readonly rule: "foreign_plugin_internals";
	readonly file: string;
	readonly importPath: string;
};

type PluginPackage = {
	readonly directory: string;
	readonly packageName: string;
};

const CONTRACT_SUBPATH = "contract";
const INSTALLED_DEPENDENCIES = "node_modules";
const SOURCE_FILES = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
const MODULE_SPECIFIER =
	/(?<![\w$.])(?:from|import\s*\(?|require\s*\()\s*(["'`])([^"'`\r\n]+)\1/g;

export async function findPluginBoundaryViolations(
	packagesDirectory: string,
): Promise<readonly PluginBoundaryViolation[]> {
	const plugins = await findPluginPackages(packagesDirectory);
	const violations: PluginBoundaryViolation[] = [];
	for (const plugin of plugins) {
		const foreignPlugins = plugins.filter((other) => other !== plugin);
		for await (const path of SOURCE_FILES.scan(
			join(packagesDirectory, plugin.directory),
		)) {
			if (path.split(sep).includes(INSTALLED_DEPENDENCIES)) continue;
			const file = join(plugin.directory, path);
			const source = await Bun.file(join(packagesDirectory, file)).text();
			for (const importPath of importPathsIn(source)) {
				const target = importedPlugin(
					packagesDirectory,
					file,
					importPath,
					foreignPlugins,
				);
				if (target !== undefined && !isContractOf(target, importPath))
					violations.push({
						rule: "foreign_plugin_internals",
						file,
						importPath,
					});
			}
		}
	}
	return violations;
}

async function findPluginPackages(
	packagesDirectory: string,
): Promise<readonly PluginPackage[]> {
	const entries = await readdir(packagesDirectory, { withFileTypes: true });
	const found: PluginPackage[] = [];
	for (const entry of entries) {
		const file = Bun.file(join(packagesDirectory, entry.name, "package.json"));
		if (!(await file.exists())) continue;
		const packageJson: unknown = await file.json();
		if (
			isRecord(packageJson) &&
			typeof packageJson.name === "string" &&
			isRecord(packageJson.workbench) &&
			packageJson.workbench.plugin !== undefined
		)
			found.push({ directory: entry.name, packageName: packageJson.name });
	}
	return found;
}

function importPathsIn(source: string): string[] {
	return Array.from(source.matchAll(MODULE_SPECIFIER)).flatMap(
		([, , importPath]) => (importPath === undefined ? [] : [importPath]),
	);
}

function importedPlugin(
	packagesDirectory: string,
	file: string,
	importPath: string,
	plugins: readonly PluginPackage[],
): PluginPackage | undefined {
	if (isPathImport(importPath)) {
		const [directory] = relative(
			packagesDirectory,
			resolve(packagesDirectory, dirname(file), importPath),
		).split(sep);
		return plugins.find((plugin) => plugin.directory === directory);
	}
	return plugins.find(
		(plugin) =>
			importPath === plugin.packageName ||
			importPath.startsWith(`${plugin.packageName}/`),
	);
}

function isContractOf(plugin: PluginPackage, importPath: string): boolean {
	return importPath === `${plugin.packageName}/${CONTRACT_SUBPATH}`;
}

function isPathImport(importPath: string): boolean {
	return importPath.startsWith(".") || importPath.startsWith("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
