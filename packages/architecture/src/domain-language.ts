import { join, sep } from "node:path";

export type DomainTermUse = {
	readonly file: string;
	readonly term: string;
};

const DOMAIN_TERMS: readonly string[] = [
	"agent factory",
	"backlog",
	"board",
	"chat",
	"forge",
	"graph view",
	"issue tracker",
	"kanban",
	"milestone",
	"note",
	"sprint",
	"swimlane",
	"ticket",
	"whiteboard",
];

const INSTALLED_DEPENDENCIES = "node_modules";
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const ALL_FILES = new Bun.Glob("**/*");
const LETTERS = /[A-Za-z]+/g;
const WORD_BOUNDARY = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

export async function findDomainLanguage(
	directory: string,
): Promise<readonly DomainTermUse[]> {
	const uses: DomainTermUse[] = [];
	for await (const file of ALL_FILES.scan(directory)) {
		if (
			file.split(sep).includes(INSTALLED_DEPENDENCIES) ||
			TEST_FILE.test(file)
		)
			continue;
		const words = wordsOf(await Bun.file(join(directory, file)).text());
		for (const term of DOMAIN_TERMS)
			if (contains(words, term.split(" "))) uses.push({ file, term });
	}
	return uses.sort(
		(a, b) => a.file.localeCompare(b.file) || a.term.localeCompare(b.term),
	);
}

function wordsOf(text: string): string[] {
	return Array.from(text.match(LETTERS) ?? []).flatMap((run) =>
		run.split(WORD_BOUNDARY).map((word) => word.toLowerCase()),
	);
}

function contains(words: readonly string[], term: readonly string[]): boolean {
	return words.some((_, start) =>
		term.every((termWord, offset) => {
			const word = words[start + offset];
			return (
				word === termWord ||
				(offset === term.length - 1 && word === `${termWord}s`)
			);
		}),
	);
}
