import { fileURLToPath } from "node:url";
import { DATABASE_CAPABILITY } from "@workbench/sdk";
import { CORE_OPERATIONS } from "./core-operations.ts";
import type { SetTimer } from "./hook-timeout.ts";
import {
	API_VERSION,
	IDEMPOTENCY_KEY_HEADER,
	OPERATION_PATH_TEMPLATE,
} from "./http-api.ts";
import {
	IDEMPOTENCY_KEY_PATTERN,
	TAKES_IDEMPOTENCY_KEY,
} from "./idempotency-keys.ts";
import type { JsonSchema } from "./json-schema.ts";
import type { PluginPackage } from "./kernel.ts";
import type { RegisteredOperation } from "./operation-registry.ts";
import { catalogPlugins } from "./plugin-catalog.ts";
import { PROBLEM_CONTENT_TYPE } from "./problem-details.ts";
import { CORRELATION_ID_HEADER, VALID_CORRELATION_ID } from "./server.ts";

export const OPENAPI_DOCUMENT_PATH = fileURLToPath(
	new URL("../../../docs/openapi.json", import.meta.url),
);

const OPENAPI_VERSION = "3.1.1";

const JSON_CONTENT_TYPE = "application/json";

const LOAD_TIMEOUT_MS = 10_000;

const PROBLEM_DETAILS_REF = "#/components/schemas/ProblemDetails";

const CORRELATION_ID_REF = "#/components/headers/CorrelationId";

type Content = {
	readonly [contentType: string]: { readonly schema: JsonSchema };
};

export type OpenApiOperation = {
	readonly operationId: string;
	readonly parameters: readonly JsonSchema[];
	readonly requestBody: { readonly required: true; readonly content: Content };
	readonly responses: {
		readonly [status: string]: {
			readonly description: string;
			readonly headers: { readonly [name: string]: JsonSchema };
			readonly content: Content;
		};
	};
};

export type OpenApiDocument = {
	readonly openapi: string;
	readonly info: { readonly title: string; readonly version: string };
	readonly security: readonly JsonSchema[];
	readonly components: JsonSchema;
	readonly paths: {
		readonly [path: string]: { readonly post: OpenApiOperation } | undefined;
	};
};

export class HttpApiDescriptionError extends Error {
	constructor(detail: string) {
		super(`the HTTP API cannot be described: ${detail}`);
		this.name = "HttpApiDescriptionError";
	}
}

const PROBLEM_DETAILS_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		type: { type: "string" },
		title: { type: "string" },
		status: { type: "integer" },
		detail: { type: "string" },
		code: { type: "string" },
		correlationId: { type: "string" },
		issues: {
			type: "array",
			items: {
				type: "object",
				properties: {
					path: {
						type: "array",
						items: { type: ["string", "integer"] },
					},
					message: { type: "string" },
				},
				required: ["path", "message"],
			},
		},
	},
	required: [
		"type",
		"title",
		"status",
		"detail",
		"code",
		"correlationId",
		"issues",
	],
};

const CORRELATION_ID_HEADER_SCHEMA: JsonSchema = {
	description: "the correlation ID of the request, also in its log entries",
	required: true,
	schema: { type: "string", pattern: VALID_CORRELATION_ID.source },
};

const WORKSPACE_PARAMETER: JsonSchema = {
	name: "workspace",
	in: "path",
	required: true,
	schema: { type: "string", format: "uuid" },
};

const IDEMPOTENCY_KEY_PARAMETER: JsonSchema = {
	name: IDEMPOTENCY_KEY_HEADER,
	in: "header",
	required: false,
	description:
		"a key of the caller under which a repeated call receives the answer of the first instead of running the mutation again",
	schema: { type: "string", pattern: IDEMPOTENCY_KEY_PATTERN },
};

const RESPONSE_HEADERS = {
	[CORRELATION_ID_HEADER]: { $ref: CORRELATION_ID_REF },
};

const PROBLEM_CONTENT: Content = {
	[PROBLEM_CONTENT_TYPE]: { schema: { $ref: PROBLEM_DETAILS_REF } },
};

export async function describeHttpApi(
	packages: readonly PluginPackage[],
	setTimer: SetTimer,
): Promise<OpenApiDocument> {
	const operations = await operationsOf(packages, setTimer);
	return {
		openapi: OPENAPI_VERSION,
		info: { title: "Workbench HTTP API", version: API_VERSION },
		security: [{ apiToken: [] }],
		components: {
			securitySchemes: { apiToken: { type: "http", scheme: "bearer" } },
			schemas: { ProblemDetails: PROBLEM_DETAILS_SCHEMA },
			headers: { CorrelationId: CORRELATION_ID_HEADER_SCHEMA },
		},
		paths: Object.fromEntries(
			operations
				.toSorted((left, right) => left.name.localeCompare(right.name))
				.map((operation) => [
					OPERATION_PATH_TEMPLATE.replace("{operation}", operation.name),
					{ post: describeOperation(operation) },
				]),
		),
	};
}

async function operationsOf(
	packages: readonly PluginPackage[],
	setTimer: SetTimer,
): Promise<readonly RegisteredOperation[]> {
	const catalog = catalogPlugins(packages, [DATABASE_CAPABILITY], {
		ms: LOAD_TIMEOUT_MS,
		setTimer,
	});
	const operations: RegisteredOperation[] = [...CORE_OPERATIONS];
	for (const { pluginName } of packages) {
		const load = await catalog.load(pluginName);
		if (!load.loaded) throw new HttpApiDescriptionError(load.failure.detail);
		operations.push(...load.plugin.operations);
	}
	return operations;
}

function describeOperation(operation: RegisteredOperation): OpenApiOperation {
	return {
		operationId: operation.name,
		parameters: [
			WORKSPACE_PARAMETER,
			...(TAKES_IDEMPOTENCY_KEY[operation.kind]
				? [IDEMPOTENCY_KEY_PARAMETER]
				: []),
		],
		requestBody: {
			required: true,
			content: { [JSON_CONTENT_TYPE]: { schema: operation.describeInput() } },
		},
		responses: {
			"200": {
				description: "the output of the operation",
				headers: RESPONSE_HEADERS,
				content: {
					[JSON_CONTENT_TYPE]: { schema: operation.describeOutput() },
				},
			},
			"401": {
				description: "the request carries no valid API token",
				headers: RESPONSE_HEADERS,
				content: PROBLEM_CONTENT,
			},
			default: {
				description: "the operation failed",
				headers: RESPONSE_HEADERS,
				content: PROBLEM_CONTENT,
			},
		},
	};
}
