import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type Validator, validatorOf } from "./schema-validation.ts";
import { storedPayloadOf } from "./stored-payload.ts";

function validating(schema: unknown): Validator {
	const validate = validatorOf(schema);
	if (validate === undefined) throw new Error("the fixture is no schema");
	return validate;
}

function cycle(): unknown {
	const card: Record<string, unknown> = {};
	card.self = card;
	return card;
}

describe("the stored form of a payload", () => {
	test("is the JSON of what the schema makes of the payload", async () => {
		const validate = validating(z.object({ cardId: z.string().trim() }));

		const stored = await storedPayloadOf(
			{ cardId: " card-1 ", color: "red" },
			validate,
		);

		expect(stored).toEqual({ valid: true, json: '{"cardId":"card-1"}' });
	});

	test("names the issues of a payload its schema rejects", async () => {
		const validate = validating(z.object({ cardId: z.string() }));

		const stored = await storedPayloadOf({ cardId: 7 }, validate);

		expect(stored).toEqual({
			valid: false,
			issues: [expect.objectContaining({ path: ["cardId"] })],
		});
	});

	test("is rejected when the schema does not accept as input what it returned as output", async () => {
		const validate = validating(z.object({ dueAt: z.date() }));

		const stored = await storedPayloadOf({ dueAt: new Date(0) }, validate);

		expect(stored).toEqual({
			valid: false,
			issues: [expect.objectContaining({ path: ["dueAt"] })],
		});
	});

	test("is accepted when the schema reads its own output again", async () => {
		const validate = validating(z.object({ dueAt: z.coerce.date() }));

		const stored = await storedPayloadOf({ dueAt: new Date(0) }, validate);

		expect(stored).toEqual({
			valid: true,
			json: '{"dueAt":"1970-01-01T00:00:00.000Z"}',
		});
	});

	test.each([
		["nothing", undefined],
		["a function", () => {}],
		["a symbol", Symbol("card")],
		["a BigInt", 7n],
		["an object that contains itself", cycle()],
	])("is rejected for %s, which has no JSON form", async (_case, payload) => {
		const stored = await storedPayloadOf(payload, validating(z.unknown()));

		expect(stored).toEqual({
			valid: false,
			issues: [{ path: [], message: "the payload has no JSON form" }],
		});
	});

	test.each([
		["a string", "card\u0000", []],
		["a nested string", { cards: ["card-1", "card\u0000"] }, ["cards", 1]],
		["a key", { cards: { "card\u0000": 1 } }, ["cards", "card\u0000"]],
		["half a surrogate pair", { title: "card\ud83d" }, ["title"]],
	])(
		"is rejected for a NUL character or broken Unicode in %s, which jsonb cannot store",
		async (_case, payload, path) => {
			const stored = await storedPayloadOf(payload, validating(z.unknown()));

			expect(stored).toEqual({
				valid: false,
				issues: [
					{
						path,
						message:
							"the payload contains text that Postgres cannot store as JSON: a NUL character or half a surrogate pair",
					},
				],
			});
		},
	);

	test("accepts text that only spells the escape of a NUL character", async () => {
		const stored = await storedPayloadOf(
			"card\\u0000",
			validating(z.unknown()),
		);

		expect(stored).toEqual({ valid: true, json: '"card\\\\u0000"' });
	});

	test.each([
		["a number", 7, "7"],
		["false", false, "false"],
		["a string", "card-1", '"card-1"'],
		["null", null, "null"],
	])("is JSON for %s as for an object", async (_case, payload, json) => {
		const stored = await storedPayloadOf(payload, validating(z.unknown()));

		expect(stored).toEqual({ valid: true, json });
	});
});
