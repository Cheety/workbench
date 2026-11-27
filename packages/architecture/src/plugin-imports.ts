import { dirname, join, resolve, sep } from "node:path";
import { INSTALLED_DEPENDENCIES, TEST_FILE } from "./domain-language.ts";
import {
	findPluginPackages,
	importedPlugin,
	importsIn,
	SOURCE_FILES,
} from "./plugin-boundaries.ts";

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
		if (
			path.split(sep).includes(INSTALLED_DEPENDENCIES) ||
			TEST_FILE.test(path)
		)
			continue;
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
