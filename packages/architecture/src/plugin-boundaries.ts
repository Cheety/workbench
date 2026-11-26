import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type PluginBoundaryViolation = ImportViolation | ContractExportViolation;

type ImportViolation = {
	readonly rule: "foreign_plugin_internals" | "contract_imports_plugin_code";
	readonly file: string;
	readonly importPath: string;
};

type ContractExportViolation = {
	readonly rule: "contract_beside_entry" | "contract_export_not_a_path";
	readonly file: string;
};

type PluginPackage = {
	readonly root: string;
	readonly packageName: string;
	readonly contractDirectory: string | undefined;
	readonly contractProblem: ContractExportViolation["rule"] | undefined;
};

type Import = {
	readonly file: string;
	readonly importPath: string;
	readonly isPath: boolean;
};

const PACKAGE_JSON = "package.json";
const CONTRACT_SUBPATH = "contract";
const INSTALLED_DEPENDENCIES = "node_modules";
const SOURCE_FILES = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;
const MODULE_SPECIFIER = new RegExp(
	String.raw`(?<![\w$.])(?:import\.meta\.resolve|require\.resolve|mock\.module|from|import|require)${GAP}\(?${GAP}(["'\x60])([^"'\x60\r\n]+)\1`,
	"g",
);
const REFERENCE_DIRECTIVE =
	/^[ \t]*\/\/\/[ \t]*<reference[ \t]+(path|types)[ \t]*=[ \t]*(["'])([^"'\r\n]+)\2/gm;

export async function findPluginBoundaryViolations(
	packagesDirectory: string,
): Promise<readonly PluginBoundaryViolation[]> {
	const plugins = await findPluginPackages(packagesDirectory);
	const violations: PluginBoundaryViolation[] = [];
	for (const plugin of plugins) {
		if (plugin.contractProblem !== undefined)
			violations.push({
				rule: plugin.contractProblem,
				file: relative(packagesDirectory, join(plugin.root, PACKAGE_JSON)),
			});
		for await (const path of SOURCE_FILES.scan(plugin.root)) {
			if (path.split(sep).includes(INSTALLED_DEPENDENCIES)) continue;
			const file = join(plugin.root, path);
			for (const { importPath, isPath } of importsIn(
				await Bun.file(file).text(),
			)) {
				const rule = violatedRule(
					{ file, importPath, isPath },
					plugin,
					plugins,
				);
				if (rule !== undefined)
					violations.push({
						rule,
						file: relative(packagesDirectory, file),
						importPath,
					});
			}
		}
	}
	return violations;
}

function violatedRule(
	{ file, importPath, isPath }: Import,
	plugin: PluginPackage,
	plugins: readonly PluginPackage[],
): ImportViolation["rule"] | undefined {
	const importedFile = isPath ? resolve(dirname(file), importPath) : undefined;
	const target = importedPlugin(importPath, importedFile, plugins);
	if (target === undefined || isContractImport(target, importPath))
		return undefined;
	if (target !== plugin) return "foreign_plugin_internals";
	const { contractDirectory } = plugin;
	const isFromContract =
		contractDirectory !== undefined && isWithin(file, contractDirectory);
	const staysInContract =
		contractDirectory !== undefined &&
		importedFile !== undefined &&
		isWithin(importedFile, contractDirectory);
	return isFromContract && !staysInContract
		? "contract_imports_plugin_code"
		: undefined;
}

async function findPluginPackages(
	packagesDirectory: string,
): Promise<readonly PluginPackage[]> {
	const entries = await readdir(packagesDirectory, { withFileTypes: true });
	const found = await Promise.all(
		entries.map((entry) =>
			readPluginPackage(join(packagesDirectory, entry.name)),
		),
	);
	return found.filter((plugin) => plugin !== undefined);
}

async function readPluginPackage(
	root: string,
): Promise<PluginPackage | undefined> {
	const file = Bun.file(join(root, PACKAGE_JSON));
	if (!(await file.exists())) return undefined;
	const packageJson: unknown = await file.json();
	if (
		!isRecord(packageJson) ||
		typeof packageJson.name !== "string" ||
		!isRecord(packageJson.workbench) ||
		packageJson.workbench.plugin === undefined
	)
		return undefined;
	const { plugin } = packageJson.workbench;
	const entry =
		isRecord(plugin) && typeof plugin.entry === "string"
			? resolve(root, plugin.entry)
			: undefined;
	const contract = isRecord(packageJson.exports)
		? packageJson.exports[`./${CONTRACT_SUBPATH}`]
		: undefined;
	const contractDirectory =
		typeof contract === "string" ? dirname(resolve(root, contract)) : undefined;
	return {
		root,
		packageName: packageJson.name,
		contractDirectory,
		contractProblem: contractProblemOf(contract, contractDirectory, entry),
	};
}

function contractProblemOf(
	contract: unknown,
	contractDirectory: string | undefined,
	entry: string | undefined,
): ContractExportViolation["rule"] | undefined {
	if (contract === undefined) return undefined;
	if (contractDirectory === undefined) return "contract_export_not_a_path";
	if (entry !== undefined && isWithin(entry, contractDirectory))
		return "contract_beside_entry";
	return undefined;
}

function importsIn(source: string): Omit<Import, "file">[] {
	const modules = Array.from(source.matchAll(MODULE_SPECIFIER)).flatMap(
		([, , importPath]) =>
			importPath === undefined
				? []
				: [{ importPath, isPath: isPathImport(importPath) }],
	);
	const references = Array.from(source.matchAll(REFERENCE_DIRECTIVE)).flatMap(
		([, kind, , importPath]) =>
			importPath === undefined ? [] : [{ importPath, isPath: kind === "path" }],
	);
	return [...modules, ...references];
}

function isContractImport(plugin: PluginPackage, importPath: string): boolean {
	return importPath === `${plugin.packageName}/${CONTRACT_SUBPATH}`;
}

function isPathImport(importPath: string): boolean {
	return importPath.startsWith(".") || isAbsolute(importPath);
}

function importedPlugin(
	importPath: string,
	importedFile: string | undefined,
	plugins: readonly PluginPackage[],
): PluginPackage | undefined {
	const packageName =
		importedFile === undefined
			? packageNameOf(importPath)
			: installedPackageOf(importedFile);
	return plugins.find((plugin) =>
		packageName === undefined
			? importedFile !== undefined && isWithin(importedFile, plugin.root)
			: plugin.packageName === packageName,
	);
}

function packageNameOf(specifier: string): string {
	return specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/");
}

function installedPackageOf(path: string): string | undefined {
	const segments = path.split(sep);
	const start = segments.lastIndexOf(INSTALLED_DEPENDENCIES) + 1;
	return start === 0
		? undefined
		: packageNameOf(segments.slice(start).join("/"));
}

function isWithin(path: string, directory: string): boolean {
	const fromDirectory = relative(directory, path);
	return (
		fromDirectory !== ".." &&
		!fromDirectory.startsWith(`..${sep}`) &&
		!isAbsolute(fromDirectory)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
