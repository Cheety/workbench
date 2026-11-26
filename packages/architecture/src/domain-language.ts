import { join, sep } from "node:path";

export type DomainTermUse = {
	readonly file: string;
	readonly term: string;
};

type DomainTerm = {
	readonly singular: string;
	readonly plural: string;
};

const DOMAIN_TERMS: readonly DomainTerm[] = [
	{ singular: "agent factory", plural: "agent factories" },
	{ singular: "backlog", plural: "backlogs" },
	{ singular: "board", plural: "boards" },
	{ singular: "chat", plural: "chats" },
	{ singular: "forge", plural: "forges" },
	{ singular: "graph view", plural: "graph views" },
	{ singular: "issue tracker", plural: "issue trackers" },
	{ singular: "kanban", plural: "kanbans" },
	{ singular: "milestone", plural: "milestones" },
	{ singular: "note", plural: "notes" },
	{ singular: "sprint", plural: "sprints" },
	{ singular: "swimlane", plural: "swimlanes" },
	{ singular: "ticket", plural: "tickets" },
	{ singular: "whiteboard", plural: "whiteboards" },
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
		for (const { singular, plural } of DOMAIN_TERMS)
			if (contains(words, singular) || contains(words, plural))
				uses.push({ file, term: singular });
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

function contains(words: readonly string[], phrase: string): boolean {
	const phraseWords = phrase.split(" ");
	return words.some((_, start) =>
		phraseWords.every((word, offset) => words[start + offset] === word),
	);
}
