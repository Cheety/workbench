import { describe, expect, test } from "bun:test";
import type { OperationFailure } from "./operation-pipeline.ts";
import { toProblemDetails } from "./problem-details.ts";

describe("problem details of a failed operation", () => {
	test("name the code, the issues and the correlation id of invalid input", () => {
		const failure: OperationFailure = {
			code: "invalid_input",
			kind: "invalid_input",
			detail: "the input does not match the input schema of the operation",
			issues: [{ path: ["title"], message: "Too small" }],
		};

		expect(toProblemDetails(failure, "request-7")).toEqual({
			type: "urn:workbench:problem:invalid_input",
			title: "Bad Request",
			status: 400,
			detail: "the input does not match the input schema of the operation",
			code: "invalid_input",
			correlationId: "request-7",
			issues: [{ path: ["title"], message: "Too small" }],
		});
	});

	test("map an internal failure to status 500 with its detail and the correlation id", () => {
		const failure: OperationFailure = {
			code: "internal_error",
			kind: "internal",
			detail: "the detail of the failure",
			issues: [],
		};

		expect(toProblemDetails(failure, "request-8")).toEqual({
			type: "urn:workbench:problem:internal_error",
			title: "Internal Server Error",
			status: 500,
			detail: "the detail of the failure",
			code: "internal_error",
			correlationId: "request-8",
			issues: [],
		});
	});

	test.each([
		["not_found", 404, "Not Found"],
		["conflict", 409, "Conflict"],
		["rejected", 422, "Unprocessable Content"],
	] as const)(
		"map a failure of kind %s to status %d",
		(kind, status, title) => {
			const failure: OperationFailure = {
				code: "board.card_archived",
				kind,
				detail: "the card is archived",
				issues: [],
			};

			expect(toProblemDetails(failure, "request-9")).toMatchObject({
				type: "urn:workbench:problem:board.card_archived",
				title,
				status,
				code: "board.card_archived",
			});
		},
	);
});
