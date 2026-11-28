import { z } from "zod";
import { OPENAPI_DOCUMENT_PATH } from "../openapi.ts";

const documentedPaths = z.object({
	paths: z.record(z.string(), z.unknown()),
});

const documentedMutation = z.object({
	post: z.object({
		parameters: z.tuple([
			z.object({ name: z.literal("workspace") }),
			z.object({
				name: z.literal("Idempotency-Key"),
				schema: z.object({ pattern: z.string() }),
			}),
		]),
	}),
});

export async function documentedIdempotencyKeyPattern(
	operation: string,
): Promise<string> {
	const { paths } = documentedPaths.parse(
		await Bun.file(OPENAPI_DOCUMENT_PATH).json(),
	);
	const { post } = documentedMutation.parse(
		paths[`/api/workspaces/{workspace}/operations/${operation}`],
	);
	const [, idempotencyKey] = post.parameters;
	return idempotencyKey.schema.pattern;
}
