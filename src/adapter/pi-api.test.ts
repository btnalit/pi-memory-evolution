import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { isMemoryEvolutionHost } from "./pi-api.ts";

describe("isMemoryEvolutionHost", () => {
	test("accepts an object with an on function", () => {
		assert.equal(isMemoryEvolutionHost({ on: () => undefined }), true);
	});

	test("rejects null", () => {
		assert.equal(isMemoryEvolutionHost(null), false);
	});

	test("rejects undefined", () => {
		assert.equal(isMemoryEvolutionHost(undefined), false);
	});

	test("rejects an object without on", () => {
		assert.equal(isMemoryEvolutionHost({}), false);
	});

	test("rejects an object with a non-function on", () => {
		assert.equal(isMemoryEvolutionHost({ on: "not a function" }), false);
	});
});
