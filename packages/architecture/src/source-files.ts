import { sep } from "node:path";

export const INSTALLED_DEPENDENCIES = "node_modules";
export const SOURCE_EXTENSIONS = [
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
];
export const SOURCE_FILES = new Bun.Glob(
	`**/*.{${SOURCE_EXTENSIONS.join(",")}}`,
);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

export function isTestFile(path: string): boolean {
	return TEST_FILE.test(path);
}

export function isInstalledDependency(path: string): boolean {
	return path.split(sep).includes(INSTALLED_DEPENDENCIES);
}
