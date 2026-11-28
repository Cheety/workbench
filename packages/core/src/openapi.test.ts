import { afterEach, describe, expect, test } from "bun:test";
import { defineOperation, definePlugin } from "@workbench/sdk";
import { z } from "zod";
import { setSystemTimer } from "./hook-timeout.ts";
import type { PluginPackage } from "./kernel.ts";
import {
	describeHttpApi,
	OPENAPI_DOCUMENT_PATH,
	type OpenApiDocument,
	type OpenApiOperation,
} from "./openapi.ts";
import { discoverPluginPackages } from "./plugin-discovery.ts";
import {
	API_INSTANCE_WORKSPACE,
	type ApiInstance,
	startApiInstance,
} from "./testing/api-instance.ts";

const PACKAGES_DIRECTORY = new URL("../../", import.meta.url).pathname;

const renameLabel = defineOperation({
	name: "renameLabel",
	kind: "mutation",
	target: "workspace",
	right: "board.label.edit",
	input: z.object({ label: z.string().min(1) }),
	output: z.object({ label: z.string() }),
	execute: async ({ label }) => ({ label }),
});

const moveLabel = defineOperation({
	...renameLabel,
	name: "moveLabel",
	target: "object",
});

const opaqueSchema = {
	"~standard": {
		version: 1,
		vendor: "board",
		validate: (value: unknown) => ({ value }),
	},
} as const;

const countLabels = defineOperation({
	name: "countLabels",
	kind: "query",
	target: "workspace",
	right: "board.label.read",
	input: opaqueSchema,
	output: opaqueSchema,
	execute: async () => 0,
});

const board: PluginPackage = {
	packageName: "@workbench/plugin-board",
	pluginName: "board",
	version: "1.0.0",
	loadDefinition: async () => ({
		...definePlugin({ manifest: { name: "board" } }),
		rights: [
			{ name: "board.label.edit", defaultRoles: ["owner"] },
			{ name: "board.label.read", defaultRoles: ["owner"] },
		],
		operations: [renameLabel, countLabels, moveLabel],
	}),
};

const RENAME_LABEL_PATH = `/api/workspaces/${API_INSTANCE_WORKSPACE}/operations/board.renameLabel`;

const AUDIT_PATH =
	"/api/workspaces/{workspace}/operations/core.listAuditEntries";

const AUDIT_INSTANCE_PATH = `/api/workspaces/${API_INSTANCE_WORKSPACE}/operations/core.listAuditEntries`;

const auditPage = z.looseObject({
	entries: z.array(z.looseObject({ occurredAt: z.string() })),
});

const jsonSchema = z.record(z.string(), z.unknown());

const documentedComponents = z.object({
	schemas: z.record(z.string(), jsonSchema),
	headers: z.object({ CorrelationId: z.object({ schema: jsonSchema }) }),
});

const instances = new Set<ApiInstance>();

afterEach(async () => {
	for (const instance of instances) await instance.stop();
	instances.clear();
});

async function startInstance(): Promise<ApiInstance> {
	const instance = await startApiInstance([board]);
	instances.add(instance);
	return instance;
}

function bearer(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

function operationAt(
	document: OpenApiDocument,
	path: string,
): OpenApiOperation {
	const workspacePath = path.replace(API_INSTANCE_WORKSPACE, "{workspace}");
	const operation = document.paths[workspacePath]?.post;
	if (operation === undefined)
		throw new Error(`${workspacePath} is not documented`);
	return operation;
}

function resolvedSchema(document: OpenApiDocument, schema: unknown): z.ZodType {
	const pointingIntoDefinitions = JSON.stringify(schema).replaceAll(
		'"#/components/schemas/',
		'"#/$defs/',
	);
	return z.fromJSONSchema({
		...jsonSchema.parse(JSON.parse(pointingIntoDefinitions)),
		$defs: documentedComponents.parse(document.components).schemas,
	});
}

function documentedRequestOf(
	document: OpenApiDocument,
	path: string,
): z.ZodType {
	return resolvedSchema(
		document,
		operationAt(document, path).requestBody.content["application/json"]?.schema,
	);
}

function documentedResponseOf(
	document: OpenApiDocument,
	path: string,
	response: Response,
): z.ZodType {
	const { responses } = operationAt(document, path);
	const documented = responses[String(response.status)] ?? responses.default;
	const contentType = response.headers.get("Content-Type")?.split(";")[0] ?? "";
	return resolvedSchema(document, documented?.content[contentType]?.schema);
}

function correlationIdSchemaOf(document: OpenApiDocument): z.ZodType {
	return z.fromJSONSchema(
		documentedComponents.parse(document.components).headers.CorrelationId
			.schema,
	);
}

const CORRELATION_ID_HEADERS = {
	"X-Correlation-ID": { $ref: "#/components/headers/CorrelationId" },
};

describe("the OpenAPI document of the HTTP API", () => {
	test("describes each operation as a POST behind the bearer token with the status codes it answers", async () => {
		const document = await describeHttpApi([board], setSystemTimer);

		const operation =
			document.paths["/api/workspaces/{workspace}/operations/board.renameLabel"]
				?.post;

		expect(document).toMatchObject({
			openapi: "3.1.1",
			security: [{ apiToken: [] }],
			components: {
				securitySchemes: { apiToken: { type: "http", scheme: "bearer" } },
			},
		});
		expect(operation?.operationId).toBe("board.renameLabel");
		expect(operation?.requestBody.required).toBe(true);
		expect(Object.keys(operation?.responses ?? {})).toEqual([
			"200",
			"401",
			"403",
			"404",
			"default",
		]);
	});

	test("documents the request body an operation accepts and the instance agrees", async () => {
		const api = await startInstance();
		const token = await api.issueToken("owner");
		const document = await describeHttpApi([board], setSystemTimer);
		const accepted = documentedRequestOf(document, RENAME_LABEL_PATH);

		const answers = await Promise.all(
			[{ label: "urgent" }, { label: "" }, {}].map(async (body) => ({
				documented: accepted.safeParse(body).success,
				status: (
					await api.post(RENAME_LABEL_PATH, JSON.stringify(body), bearer(token))
				).status,
			})),
		);

		expect(answers).toEqual([
			{ documented: true, status: 200 },
			{ documented: false, status: 400 },
			{ documented: false, status: 400 },
		]);
	});

	test("documents the bodies and the correlation ID the instance answers a call with", async () => {
		const api = await startInstance();
		const token = await api.issueToken("owner");
		const document = await describeHttpApi([board], setSystemTimer);

		const answers = [
			await api.post(
				RENAME_LABEL_PATH,
				JSON.stringify({ label: "urgent" }),
				bearer(token),
			),
			await api.post(
				RENAME_LABEL_PATH,
				JSON.stringify({ label: "urgent" }),
				{},
			),
			await api.post(
				RENAME_LABEL_PATH,
				JSON.stringify({ label: "" }),
				bearer(token),
			),
		];

		const issues = await Promise.all(
			answers.map(async (response) => ({
				body: documentedResponseOf(
					document,
					RENAME_LABEL_PATH,
					response,
				).safeParse(await response.json()).error?.issues,
				correlationId: correlationIdSchemaOf(document).safeParse(
					response.headers.get("X-Correlation-ID"),
				).error?.issues,
			})),
		);
		expect(answers.map((response) => response.status)).toEqual([200, 401, 400]);
		expect(issues).toEqual([
			{ body: undefined, correlationId: undefined },
			{ body: undefined, correlationId: undefined },
			{ body: undefined, correlationId: undefined },
		]);
	});

	test.each([
		[
			"a workspace",
			"board.renameLabel",
			["missing_right"],
			["workspace_not_found"],
		],
		[
			"an object",
			"board.moveLabel",
			["missing_right", "not_object_holder"],
			["workspace_not_found", "object_not_found"],
		],
	])(
		"names the codes of a denied call on %s as 403 and 404",
		async (_case, operation, forbidden, notFound) => {
			const document = await describeHttpApi([board], setSystemTimer);

			expect(
				document.paths[`/api/workspaces/{workspace}/operations/${operation}`]
					?.post?.responses,
			).toMatchObject({
				"403": {
					headers: CORRELATION_ID_HEADERS,
					content: {
						"application/problem+json": {
							schema: {
								allOf: [
									{ $ref: "#/components/schemas/ProblemDetails" },
									{ properties: { code: { enum: forbidden } } },
								],
							},
						},
					},
				},
				"404": {
					headers: CORRELATION_ID_HEADERS,
					content: {
						"application/problem+json": {
							schema: {
								allOf: [
									{ $ref: "#/components/schemas/ProblemDetails" },
									{ properties: { code: { enum: notFound } } },
								],
							},
						},
					},
				},
			});
		},
	);

	test("describes an operation on the instance as a POST without a workspace in its path", async () => {
		const document = await describeHttpApi([], setSystemTimer);

		expect(
			document.paths["/api/operations/core.createWorkspace"]?.post,
		).toMatchObject({
			operationId: "core.createWorkspace",
			parameters: [expect.objectContaining({ name: "Idempotency-Key" })],
			responses: {
				"403": {
					content: {
						"application/problem+json": {
							schema: {
								allOf: [
									{ $ref: "#/components/schemas/ProblemDetails" },
									{ properties: { code: { enum: ["not_instance_admin"] } } },
								],
							},
						},
					},
				},
			},
		});
		expect(Object.keys(document.paths)).not.toContain(
			"/api/workspaces/{workspace}/operations/core.createWorkspace",
		);
	});

	test("names not_instance_admin, but not missing_right, for an operation on a workspace that only an instance admin calls", async () => {
		const document = await describeHttpApi([], setSystemTimer);

		expect(
			document.paths[
				"/api/workspaces/{workspace}/operations/core.grantMembership"
			]?.post?.responses,
		).toMatchObject({
			"403": {
				content: {
					"application/problem+json": {
						schema: {
							allOf: [
								{ $ref: "#/components/schemas/ProblemDetails" },
								{ properties: { code: { enum: ["not_instance_admin"] } } },
							],
						},
					},
				},
			},
		});
	});

	test("names no denied call for the list of workspaces, which every actor calls", async () => {
		const document = await describeHttpApi([], setSystemTimer);

		expect(
			Object.keys(
				document.paths["/api/operations/core.listWorkspaces"]?.post
					?.responses ?? {},
			),
		).toEqual(["200", "401", "default"]);
	});

	test("offers a mutation, but not a query, an optional Idempotency-Key header", async () => {
		const document = await describeHttpApi([board], setSystemTimer);

		const parametersOf = (operation: string) =>
			document.paths[`/api/workspaces/{workspace}/operations/${operation}`]
				?.post?.parameters;

		expect(parametersOf("board.renameLabel")).toEqual([
			{
				name: "workspace",
				in: "path",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
			expect.objectContaining({
				name: "Idempotency-Key",
				in: "header",
				required: false,
				schema: { type: "string", pattern: "^[ -+\\--~]{1,255}$" },
			}),
		]);
		expect(parametersOf("board.countLabels")).toEqual([
			{
				name: "workspace",
				in: "path",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
		]);
	});

	test("admits any JSON for a schema that cannot describe itself as JSON Schema", async () => {
		const document = await describeHttpApi([board], setSystemTimer);

		expect(
			document.paths["/api/workspaces/{workspace}/operations/board.countLabels"]
				?.post?.requestBody.content["application/json"]?.schema,
		).toEqual({});
	});

	test("describes the operations of the core next to those of the plugin packages", async () => {
		const document = await describeHttpApi([board], setSystemTimer);

		expect(Object.keys(document.paths)).toEqual(
			expect.arrayContaining([
				AUDIT_PATH,
				"/api/workspaces/{workspace}/operations/board.renameLabel",
			]),
		);
		expect(document.paths[AUDIT_PATH]?.post?.operationId).toBe(
			"core.listAuditEntries",
		);
	});

	test("documents the page of the audit the instance answers, with each time as an RFC 3339 date-time", async () => {
		const api = await startInstance();
		const token = await api.issueToken("owner");
		const document = await describeHttpApi([board], setSystemTimer);
		await api.post(
			RENAME_LABEL_PATH,
			JSON.stringify({ label: "urgent" }),
			bearer(token),
		);
		const request = { limit: 10, cursor: null };

		const response = await api.post(
			AUDIT_INSTANCE_PATH,
			JSON.stringify(request),
			bearer(token),
		);

		const documentedPage = documentedResponseOf(document, AUDIT_PATH, response);
		const page = auditPage.parse(await response.json());
		const [entry] = page.entries;
		expect(response.status).toBe(200);
		expect(entry).toBeDefined();
		expect(
			documentedRequestOf(document, AUDIT_PATH).safeParse(request).success,
		).toBe(true);
		expect(documentedPage.safeParse(page).error?.issues).toBeUndefined();
		expect(
			documentedPage.safeParse({
				...page,
				entries: [{ ...entry, occurredAt: "26 November 2026" }],
			}).success,
		).toBe(false);
	});

	test.each([
		[{ limit: 0, cursor: null }],
		[{ limit: 101, cursor: null }],
		[{ limit: 10 }],
	])(
		"documents that the audit refuses the page request %j, as the instance does",
		async (request) => {
			const api = await startInstance();
			const token = await api.issueToken("owner");
			const document = await describeHttpApi([board], setSystemTimer);

			const response = await api.post(
				AUDIT_INSTANCE_PATH,
				JSON.stringify(request),
				bearer(token),
			);

			expect(response.status).toBe(400);
			expect(
				documentedRequestOf(document, AUDIT_PATH).safeParse(request).success,
			).toBe(false);
		},
	);

	test("describes the list of operations as a GET answering with the list or problem details", async () => {
		const document = await describeHttpApi([], setSystemTimer);

		const listing = document.paths["/api/operations"];

		expect(listing?.post).toBeUndefined();
		expect(listing?.get?.operationId).toBe("listOperations");
		expect(Object.keys(listing?.get?.responses ?? {})).toEqual([
			"200",
			"401",
			"default",
		]);
	});

	test("in the repository matches the operations of all plugin packages", async () => {
		const { packages } = await discoverPluginPackages(PACKAGES_DIRECTORY)();
		const expected = await describeHttpApi(packages, setSystemTimer);

		const committed: unknown = await Bun.file(OPENAPI_DOCUMENT_PATH).json();

		expect(committed).toEqual(expected);
	});
});
