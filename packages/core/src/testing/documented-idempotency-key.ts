import { z } from "zod";
import { OPENAPI_DOCUMENT_PATH } from "../openapi.ts";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

const documentedPaths = z.object({
	paths: z.record(z.string(), z.unknown()),
});

const documentedMutation = z.object({
	post: z.object({
		parameters: z.array(z.looseObject({ name: z.string() })),
	}),
});

const documentedIdempotencyKey = z.object({
	schema: z.object({ pattern: z.string() }),
});

class UndocumentedIdempotencyKeyError extends Error {
	constructor(operation: string) {
		super(
			`the committed OpenAPI document names no ${IDEMPOTENCY_KEY_HEADER} parameter for ${operation}`,
		);
		this.name = "UndocumentedIdempotencyKeyError";
	}
}

export async function documentedIdempotencyKeyPattern(
	operation: string,
): Promise<string> {
	const { paths } = documentedPaths.parse(
		await Bun.file(OPENAPI_DOCUMENT_PATH).json(),
	);
	const { post } = documentedMutation.parse(
		paths[`/api/workspaces/{workspace}/operations/${operation}`],
	);
	const parameter = post.parameters.find(
		({ name }) => name === IDEMPOTENCY_KEY_HEADER,
	);
	if (parameter === undefined)
		throw new UndocumentedIdempotencyKeyError(operation);
	return documentedIdempotencyKey.parse(parameter).schema.pattern;
}
