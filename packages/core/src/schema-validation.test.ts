import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	InvalidSchemaResultError,
	type Validator,
	validatorOf,
} from "./schema-validation.ts";

function schemaReturning(result: unknown): unknown {
	return {
		"~standard": { version: 1, vendor: "fixture", validate: () => result },
	};
}

function validatorReturning(result: unknown): Validator {
	const validate = validatorOf(schemaReturning(result));
	if (validate === undefined) throw new Error("the fixture is no schema");
	return validate;
}

const RESULT_DELIVERIES: [string, (result: unknown) => unknown][] = [
	["at once", (result) => result],
	["as a promise", (result) => Promise.resolve(result)],
];

describe("validating with a Standard Schema", () => {
	test.each(RESULT_DELIVERIES)(
		"reads the value of a result the schema returns %s",
		async (_case, deliver) => {
			const validate = validatorReturning(
				deliver({ value: { title: "Milk" } }),
			);

			const validation = await validate({});

			expect(validation).toEqual({ valid: true, value: { title: "Milk" } });
		},
	);

	test.each(RESULT_DELIVERIES)(
		"reads the issues of a result the schema returns %s",
		async (_case, deliver) => {
			const validate = validatorReturning(
				deliver({ issues: [{ message: "Required", path: ["title"] }] }),
			);

			const validation = await validate({});

			expect(validation).toEqual({
				valid: false,
				issues: [{ path: ["title"], message: "Required" }],
			});
		},
	);

	test("rejects a value a schema with an asynchronous refinement refuses", async () => {
		const validate = validatorOf(
			z.string().refine(async (title) => title.length > 0, "Required"),
		);

		const validation = await validate?.("");

		expect(validation).toEqual({
			valid: false,
			issues: [{ path: [], message: "Required" }],
		});
	});

	test("reads the path and message of each issue", async () => {
		const validate = validatorReturning({
			issues: [{ message: "Too small", path: ["items", { key: 0 }, "title"] }],
		});

		const validation = await validate({});

		expect(validation).toEqual({
			valid: false,
			issues: [{ path: ["items", 0, "title"], message: "Too small" }],
		});
	});

	test("gives an issue without a path the empty path", async () => {
		const validate = validatorReturning({ issues: [{ message: "Required" }] });

		const validation = await validate({});

		expect(validation).toEqual({
			valid: false,
			issues: [{ path: [], message: "Required" }],
		});
	});

	test.each([
		["an issue that is no object", "Too small"],
		["an issue without a message", { path: ["title"] }],
		["an issue whose message is no string", { message: 42, path: [] }],
	])("rejects a result with %s", async (_case, issue) => {
		const validate = validatorReturning({ issues: [issue] });

		const validation = validate({});

		await expect(validation).rejects.toThrow(InvalidSchemaResultError);
	});
});
