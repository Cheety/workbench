import { OperationError } from "@workbench/sdk";
import { z } from "zod";

const MAX_PAGE_SIZE = 100;

export type PageRequest = {
	readonly limit: number;
	readonly cursor: string | null;
};

export function pageRequestSchema(
	maxCursorLength: number,
): z.ZodType<PageRequest> {
	return z.object({
		limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
		cursor: z.string().max(maxCursorLength).nullable(),
	});
}

export type Page<Row> = {
	readonly rows: readonly Row[];
	readonly nextCursor: string | null;
};

export type Keyset<Row, Position> = {
	readonly list: string;
	readonly row: z.ZodType<Row>;
	readonly position: z.ZodType<Position>;
	positionOf(row: Row): Position;
	encode(position: Position): unknown;
};

export type RowsAfter<Position> = (
	after: Position | null,
	upTo: number,
) => Promise<readonly unknown[]>;

export async function pageOf<Row, Position>(
	keyset: Keyset<Row, Position>,
	{ limit, cursor }: PageRequest,
	rowsAfter: RowsAfter<Position>,
): Promise<Page<Row>> {
	const after = cursor === null ? null : positionOf(keyset, cursor);
	const found = z.array(keyset.row).parse(await rowsAfter(after, limit + 1));
	const rows = found.slice(0, limit);
	const last = rows.at(-1);
	return {
		rows,
		nextCursor:
			found.length > limit && last !== undefined
				? cursorAfter(keyset, keyset.positionOf(last))
				: null,
	};
}

function cursorAfter<Row, Position>(
	keyset: Keyset<Row, Position>,
	position: Position,
): string {
	return Buffer.from(JSON.stringify(keyset.encode(position))).toString(
		"base64url",
	);
}

function positionOf<Row, Position>(
	keyset: Keyset<Row, Position>,
	cursor: string,
): Position {
	const position = keyset.position.safeParse(decodedJson(cursor));
	if (!position.success || cursorAfter(keyset, position.data) !== cursor)
		throw new OperationError(
			"rejected",
			"invalid_cursor",
			`the cursor does not name a position in ${keyset.list}`,
		);
	return position.data;
}

function decodedJson(cursor: string): unknown {
	try {
		const decoded: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		return decoded;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}
