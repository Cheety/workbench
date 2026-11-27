import { join, relative } from "node:path";
import { findPluginPackages, isContractFile } from "./plugin-boundaries.ts";
import {
	isInstalledDependency,
	isTestFile,
	SOURCE_FILES,
} from "./source-files.ts";

export type EventDefinitionSites = {
	readonly inContract: readonly string[];
	readonly outsideContract: readonly string[];
};

const DEFINE_EVENT = /(?<![\w$])defineEvent(?![\w$])/;

export async function findEventDefinitions(
	packagesDirectory: string,
): Promise<EventDefinitionSites> {
	const plugins = await findPluginPackages(packagesDirectory);
	const inContract: string[] = [];
	const outsideContract: string[] = [];
	for (const plugin of plugins)
		for await (const path of SOURCE_FILES.scan(plugin.root)) {
			if (isInstalledDependency(path) || isTestFile(path)) continue;
			const file = join(plugin.root, path);
			if (!DEFINE_EVENT.test(await Bun.file(file).text())) continue;
			const sites = isContractFile(file, plugin.contract)
				? inContract
				: outsideContract;
			sites.push(relative(packagesDirectory, file));
		}
	return { inContract, outsideContract };
}
