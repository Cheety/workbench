import { dirname, join, resolve } from "node:path";
import {
	findPluginPackages,
	importedPlugin,
	importsIn,
} from "./plugin-boundaries.ts";
import {
	isInstalledDependency,
	isTestFile,
	SOURCE_FILES,
} from "./source-files.ts";

export type PluginImport = {
	readonly file: string;
	readonly importPath: string;
};

export async function findPluginImports(
	directory: string,
	packagesDirectory: string,
): Promise<readonly PluginImport[]> {
	const plugins = await findPluginPackages(packagesDirectory);
	const found: PluginImport[] = [];
	for await (const path of SOURCE_FILES.scan(directory)) {
		if (isInstalledDependency(path) || isTestFile(path)) continue;
		const file = join(directory, path);
		for (const { importPath, isPath } of importsIn(
			await Bun.file(file).text(),
		)) {
			const importedFile = isPath
				? resolve(dirname(file), importPath)
				: undefined;
			if (importedPlugin(importPath, importedFile, plugins) !== undefined)
				found.push({ file: path, importPath });
		}
	}
	return found;
}
