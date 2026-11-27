import { describe, expect, test } from "bun:test";
import { defineOperation, definePlugin } from "@workbench/sdk";
import { z } from "zod";
import { setSystemTimer } from "./hook-timeout.ts";
import type { PluginPackage } from "./kernel.ts";
import { describeHttpApi, OPENAPI_DOCUMENT_PATH } from "./openapi.ts";
import { discoverPluginPackages } from "./plugin-discovery.ts";

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
		operations: [renameLabel, countLabels],
	}),
};

const CORRELATION_ID_HEADERS = {
	"X-Correlation-ID": { $ref: "#/components/headers/CorrelationId" },
};

describe("the OpenAPI document of the HTTP API", () => {
	test("describes each operation as a POST with its schemas, the bearer token and problem details", async () => {
		const document = await describeHttpApi([board], setSystemTimer);

		expect(document).toMatchObject({
			openapi: "3.1.1",
			security: [{ apiToken: [] }],
			components: {
				securitySchemes: { apiToken: { type: "http", scheme: "bearer" } },
				headers: {
					CorrelationId: {
						required: true,
						schema: { type: "string", pattern: "^[A-Za-z0-9._-]{1,128}$" },
					},
				},
			},
			paths: {
				"/api/workspaces/{workspace}/operations/board.renameLabel": {
					post: {
						operationId: "board.renameLabel",
						parameters: [
							{
								name: "workspace",
								in: "path",
								required: true,
								schema: { type: "string", format: "uuid" },
							},
						],
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: { label: { type: "string", minLength: 1 } },
										required: ["label"],
									},
								},
							},
						},
						responses: {
							"200": {
								headers: CORRELATION_ID_HEADERS,
								content: {
									"application/json": {
										schema: {
											type: "object",
											properties: { label: { type: "string" } },
										},
									},
								},
							},
							"401": {
								headers: CORRELATION_ID_HEADERS,
								content: {
									"application/problem+json": {
										schema: { $ref: "#/components/schemas/ProblemDetails" },
									},
								},
							},
							default: {
								headers: CORRELATION_ID_HEADERS,
								content: {
									"application/problem+json": {
										schema: { $ref: "#/components/schemas/ProblemDetails" },
									},
								},
							},
						},
					},
				},
			},
		});
	});

	test("admits any JSON for a schema that cannot describe itself as JSON Schema", async () => {
		const document = await describeHttpApi([board], setSystemTimer);

		expect(
			document.paths["/api/workspaces/{workspace}/operations/board.countLabels"]
				?.post.requestBody.content["application/json"]?.schema,
		).toEqual({});
	});

	test("describes the operations of the core next to those of the plugin packages", async () => {
		const document = await describeHttpApi([board], setSystemTimer);

		expect(
			document.paths[
				"/api/workspaces/{workspace}/operations/core.listAuditEntries"
			]?.post,
		).toMatchObject({
			operationId: "core.listAuditEntries",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								limit: { type: "integer", minimum: 1, maximum: 100 },
								cursor: {
									anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }],
								},
							},
							required: ["limit", "cursor"],
						},
					},
				},
			},
		});
		expect(Object.keys(document.paths)).toContain(
			"/api/workspaces/{workspace}/operations/board.renameLabel",
		);
	});

	test("in the repository matches the operations of all plugin packages", async () => {
		const { packages } = await discoverPluginPackages(PACKAGES_DIRECTORY)();
		const expected = await describeHttpApi(packages, setSystemTimer);

		const committed: unknown = await Bun.file(OPENAPI_DOCUMENT_PATH).json();

		expect(committed).toEqual(expected);
	});
});
