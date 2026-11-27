import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	INSTALLED_DEPENDENCIES,
	isInstalledDependency,
	isTestFile,
	SOURCE_EXTENSIONS,
	SOURCE_FILES,
} from "./source-files.ts";

export type PluginBoundaryViolation =
	| ImportViolation
	| ComputedImportViolation
	| ContractExportViolation
	| ContractDirectoryViolation;

type ImportViolation = {
	readonly rule: "foreign_plugin_internals" | "contract_imports_plugin_code";
	readonly file: string;
	readonly importPath: string;
};

type ComputedImportViolation = {
	readonly rule: "computed_import";
	readonly file: string;
};

type ContractExportViolation = {
	readonly rule: "contract_beside_entry" | "contract_export_not_a_path";
	readonly file: string;
};

type ContractDirectoryViolation = {
	readonly rule: "contract_beside_other_code";
	readonly file: string;
};

type PluginPackage = {
	readonly root: string;
	readonly packageName: string;
	readonly contract: ContractExport;
};

type ContractExport =
	| { readonly kind: "absent" }
	| { readonly kind: "published"; readonly file: string }
	| {
			readonly kind: "rejected";
			readonly rule: ContractExportViolation["rule"];
	  };

type Import = {
	readonly file: string;
	readonly importPath: string;
	readonly isPath: boolean;
};

const PACKAGE_JSON = "package.json";
const CONTRACT_SUBPATH = "contract";
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;
const MODULE_SPECIFIER = new RegExp(
	String.raw`(?<![\w$.])(?:import\.meta\.resolve|require\.resolve|mock\.module|from|import|require)${GAP}\(?${GAP}(["'\x60])([^"'\x60\r\n]+)\1`,
	"g",
);
const MODULE_CALL = new RegExp(
	String.raw`(?<![\w$.])(?:import\.meta\.resolve|require\.resolve|mock\.module|import|require)${GAP}\(${GAP}`,
	"g",
);
const LITERAL_ARGUMENT = new RegExp(
	String.raw`^(?:"[^"\r\n]*"|'[^'\r\n]*'|\x60(?:[^\x60$]|\$(?!\{))*\x60)${GAP}[,)]`,
);
const REFERENCE_DIRECTIVE =
	/^[ \t]*\/\/\/[ \t]*<reference[ \t]+(path|types)[ \t]*=[ \t]*(["'])([^"'\r\n]+)\2/gm;

export async function findPluginBoundaryViolations(
	packagesDirectory: string,
): Promise<readonly PluginBoundaryViolation[]> {
	const plugins = await findPluginPackages(packagesDirectory);
	const violations: PluginBoundaryViolation[] = [];
	for (const plugin of plugins) {
		if (plugin.contract.kind === "rejected")
			violations.push({
				rule: plugin.contract.rule,
				file: relative(packagesDirectory, join(plugin.root, PACKAGE_JSON)),
			});
		const contractImports = new Map<string, string[]>();
		for await (const path of SOURCE_FILES.scan(plugin.root)) {
			if (isInstalledDependency(path)) continue;
			const file = join(plugin.root, path);
			const source = await Bun.file(file).text();
			const imports = importsIn(source);
			if (!isTestFile(file))
				for (let count = countComputedImports(source); count > 0; count--)
					violations.push({
						rule: "computed_import",
						file: relative(packagesDirectory, file),
					});
			if (isContractFile(file, plugin.contract))
				contractImports.set(
					file,
					imports.flatMap(({ importPath, isPath }) =>
						isPath ? [resolve(dirname(file), importPath)] : [],
					),
				);
			for (const { importPath, isPath } of imports) {
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
		for (const file of unreachedContractFiles(plugin.contract, contractImports))
			violations.push({
				rule: "contract_beside_other_code",
				file: relative(packagesDirectory, file),
			});
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
	return isContractFile(file, plugin.contract) &&
		(importedFile === undefined ||
			!isContractFile(importedFile, plugin.contract))
		? "contract_imports_plugin_code"
		: undefined;
}

function unreachedContractFiles(
	contract: ContractExport,
	contractImports: ReadonlyMap<string, readonly string[]>,
): string[] {
	if (contract.kind !== "published") return [];
	const reached = new Set<string>();
	const pending = [contract.file];
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (reached.has(file)) continue;
		reached.add(file);
		pending.push(
			...(contractImports.get(file) ?? []).flatMap(sourceFilesNamedBy),
		);
	}
	return Array.from(contractImports.keys()).filter(
		(file) => !reached.has(file),
	);
}

function sourceFilesNamedBy(path: string): string[] {
	return [
		path,
		...SOURCE_EXTENSIONS.flatMap((extension) => [
			`${path}.${extension}`,
			join(path, `index.${extension}`),
		]),
	];
}

export async function findPluginPackages(
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
	const exported = isRecord(packageJson.exports)
		? packageJson.exports[`./${CONTRACT_SUBPATH}`]
		: undefined;
	return {
		root,
		packageName: packageJson.name,
		contract: contractExportOf(root, exported, entry),
	};
}

function contractExportOf(
	root: string,
	exported: unknown,
	entry: string | undefined,
): ContractExport {
	if (exported === undefined) return { kind: "absent" };
	if (typeof exported !== "string")
		return { kind: "rejected", rule: "contract_export_not_a_path" };
	const file = resolve(root, exported);
	if (entry !== undefined && isWithin(entry, dirname(file)))
		return { kind: "rejected", rule: "contract_beside_entry" };
	return { kind: "published", file };
}

export function importsIn(source: string): Omit<Import, "file">[] {
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

function countComputedImports(source: string): number {
	return Array.from(source.matchAll(MODULE_CALL)).filter(
		(call) => !LITERAL_ARGUMENT.test(source.slice(call.index + call[0].length)),
	).length;
}

export function isContractFile(
	file: string,
	contract: ContractExport,
): boolean {
	return (
		contract.kind === "published" &&
		isWithin(file, dirname(contract.file)) &&
		!isTestFile(file)
	);
}

function isContractImport(plugin: PluginPackage, importPath: string): boolean {
	return importPath === `${plugin.packageName}/${CONTRACT_SUBPATH}`;
}

function isPathImport(importPath: string): boolean {
	return importPath.startsWith(".") || isAbsolute(importPath);
}

export function importedPlugin(
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
