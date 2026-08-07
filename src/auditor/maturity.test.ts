import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	computeScores,
	MATURITY_ACTION_ACTIONABILITY,
	type MaturityInput,
} from "./maturity.ts";

/** Builds a maturity input with defaults for one agenda item. */
function baseInput(overrides: Partial<MaturityInput> = {}): MaturityInput {
	return {
		evidence: [],
		uniqueCount: 0,
		observationDays: 1,
		recentMentions7d: 0,
		unresolvedCost: 0.3,
		type: "quality_improvement",
		now: "2026-08-05T00:00:00.000Z",
		...overrides,
	};
}

/** Builds one evidence record with the given properties. */
function evidence(
	overrides: Partial<MaturityInput["evidence"][number]> = {},
): MaturityInput["evidence"][number] {
	return {
		at: "2026-08-05T00:00:00.000Z",
		source: "feedback",
		weight: 0.3,
		qualified: true,
		actionable: true,
		relevance: 1.0,
		...overrides,
	};
}

describe("computeScores", () => {
	test("returns zero trend and recurrence for an empty evidence list", () => {
		const scores = computeScores(baseInput());
		assert.equal(scores.evidenceStrength, 0);
		assert.equal(scores.trendStrength, 0);
		assert.equal(scores.recurrenceDensity, 0);
		// maturity = 0.15*unresolvedCost(0.3) + 0.10*actionability(0.8) = 0.045 + 0.08 = 0.125
		assert.ok(Math.abs(scores.maturityScore - 0.125) < 0.001);
	});

	test("caps maturity at 0.50 when no qualified evidence exists", () => {
		const input = baseInput({
			evidence: [
				evidence({ qualified: false, actionable: false, weight: 0.3 }),
			],
			observationDays: 20,
		});
		const scores = computeScores(input);
		assert.ok(scores.maturityScore <= 0.5);
	});

	test("computes evidence strength from actionable qualified weight", () => {
		const input = baseInput({
			evidence: [
				evidence({ weight: 0.3, relevance: 1.0 }),
				evidence({ weight: 0.3, relevance: 1.0 }),
			],
			uniqueCount: 2,
		});
		const scores = computeScores(input);
		// actionable_qualified_strength = 0.6 -> evidence_strength = 0.6 / 1.5 = 0.4
		assert.ok(Math.abs(scores.evidenceStrength - 0.4) < 0.001);
	});

	test("applies time pressure bonus as log of observation days", () => {
		const scores1 = computeScores(
			baseInput({ evidence: [evidence()], observationDays: 1 }),
		);
		const scores30 = computeScores(
			baseInput({ evidence: [evidence()], observationDays: 30 }),
		);
		assert.ok(scores30.timePressureBonus > scores1.timePressureBonus);
		assert.ok(scores30.timePressureBonus <= 0.12);
	});

	test("applies staleness penalty after 7 days without evidence", () => {
		const input = baseInput({
			evidence: [
				evidence({ at: "2026-07-20T00:00:00.000Z" }), // 16 days before now
			],
			observationDays: 16,
		});
		const scores = computeScores(input);
		assert.ok(scores.stalenessPenalty > 0);
	});

	test("clamps maturity score to the [0,1] range", () => {
		const input = baseInput({
			evidence: [
				evidence({ weight: 0.35, relevance: 1.0 }),
				evidence({ weight: 0.35, relevance: 1.0 }),
				evidence({ weight: 0.35, relevance: 1.0 }),
				evidence({ weight: 0.35, relevance: 1.0 }),
			],
			uniqueCount: 4,
			observationDays: 30,
		});
		const scores = computeScores(input);
		assert.ok(scores.maturityScore >= 0 && scores.maturityScore <= 1);
	});

	test("uses stored unresolved cost and derives actionability from type", () => {
		const input = baseInput({
			evidence: [evidence()],
			uniqueCount: 1,
			unresolvedCost: 0.5,
			type: "strategic_positioning", // ask_user_confirmation = 0.70
		});
		const scores = computeScores(input);
		assert.equal(scores.unresolvedCost, 0.5);
		assert.equal(
			scores.actionability,
			MATURITY_ACTION_ACTIONABILITY.ask_user_confirmation,
		);
	});
});
