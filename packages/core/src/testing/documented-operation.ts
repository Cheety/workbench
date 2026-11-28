import { z } from "zod";
import { OPENAPI_DOCUMENT_PATH } from "../openapi.ts";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

const documentedPaths = z.object({
	paths: z.record(z.string(), z.unknown()),
});

const documentedOperation = z.object({
	post: z.object({
		parameters: z.array(z.looseObject({ name: z.string() })),
		requestBody: z.object({
			content: z.object({
				"application/json": z.object({
					schema: z.record(z.string(), z.unknown()),
				}),
			}),
		}),
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

async function documentedPost(operation: string) {
	const { paths } = documentedPaths.parse(
		await Bun.file(OPENAPI_DOCUMENT_PATH).json(),
	);
	return documentedOperation.parse(
		paths[`/api/workspaces/{workspace}/operations/${operation}`],
	).post;
}

export async function documentedIdempotencyKeyPattern(
	operation: string,
): Promise<string> {
	const { parameters } = await documentedPost(operation);
	const parameter = parameters.find(
		({ name }) => name === IDEMPOTENCY_KEY_HEADER,
	);
	if (parameter === undefined)
		throw new UndocumentedIdempotencyKeyError(operation);
	return documentedIdempotencyKey.parse(parameter).schema.pattern;
}

export async function documentedRequestSchema(
	operation: string,
): Promise<Readonly<Record<string, unknown>>> {
	const { requestBody } = await documentedPost(operation);
	return requestBody.content["application/json"].schema;
}
