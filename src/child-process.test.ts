import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { isSubagentProcess } from "./child-process.ts";

describe("isSubagentProcess", () => {
	test("returns false when no subagent env vars are present", () => {
		assert.equal(isSubagentProcess({}), false);
	});

	test("returns true when PI_SUBAGENT_AGENT_ID is set", () => {
		assert.equal(
			isSubagentProcess({ PI_SUBAGENT_AGENT_ID: "Researcher" }),
			true,
		);
	});

	test("returns false when the subagent env var is an empty string", () => {
		assert.equal(isSubagentProcess({ PI_SUBAGENT_AGENT_ID: "" }), false);
	});

	test("ignores unrelated env vars", () => {
		assert.equal(
			isSubagentProcess({ PATH: "/usr/bin", HOME: "/root" }),
			false,
		);
	});
});
