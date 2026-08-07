import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	classifySignal,
	evidenceWeightForSignal,
	isActionableSignal,
	isQualifiedSignal,
	SIGNAL_WEIGHTS,
} from "./mapping.ts";

describe("classifySignal", () => {
	test("classifies feedback signals as actionable and qualified", () => {
		const classification = classifySignal("feedback");
		assert.equal(classification.actionable, true);
		assert.equal(classification.qualified, true);
	});

	test("classifies projection signals as qualified but structural", () => {
		const classification = classifySignal("projection");
		assert.equal(classification.actionable, false);
		assert.equal(classification.qualified, true);
	});

	test("classifies session_stats signals as qualified but structural", () => {
		const classification = classifySignal("session_stats");
		assert.equal(classification.actionable, false);
		assert.equal(classification.qualified, true);
	});

	test("treats unknown signal types as unqualified", () => {
		const classification = classifySignal("unknown_type");
		assert.equal(classification.qualified, false);
		assert.equal(classification.actionable, false);
	});
});

describe("evidenceWeightForSignal", () => {
	test("uses the fixed weight table for known signals", () => {
		assert.equal(evidenceWeightForSignal("feedback"), SIGNAL_WEIGHTS.feedback);
		assert.equal(
			evidenceWeightForSignal("projection"),
			SIGNAL_WEIGHTS.projection,
		);
		assert.equal(
			evidenceWeightForSignal("session_stats"),
			SIGNAL_WEIGHTS.session_stats,
		);
	});

	test("uses the default weight for unknown signals", () => {
		assert.equal(evidenceWeightForSignal("unknown_type"), 0.05);
	});
});

describe("isActionableSignal / isQualifiedSignal", () => {
	test("delegates to the classification", () => {
		assert.equal(isActionableSignal("feedback"), true);
		assert.equal(isActionableSignal("projection"), false);
		assert.equal(isQualifiedSignal("feedback"), true);
		assert.equal(isQualifiedSignal("unknown_type"), false);
	});
});
