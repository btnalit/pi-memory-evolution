import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	advanceState,
	DEFAULT_MATURATION_POLICY,
	type AdvanceInput,
	type MaturationPolicy,
} from "./engine.ts";

/** Builds an advance input with defaults. */
function baseInput(overrides: Partial<AdvanceInput> = {}): AdvanceInput {
	return {
		status: "observing",
		evidenceCount: 0,
		uniqueCount: 0,
		actionableCount: 0,
		observationDays: 1,
		maturityScore: 0,
		evidenceStrength: 0,
		lastSurfacedAt: null,
		now: "2026-08-05T00:00:00.000Z",
		...overrides,
	};
}

/** A permissive policy that surfaces quickly. */
const FAST_POLICY: MaturationPolicy = {
	minScoreToSurface: 0.5,
	minEvidenceCount: 2,
	minObservationDays: 2,
	maxObservationDaysBeforeReview: 14,
	autoArchiveIfNoEvidenceDays: 21,
	sameAgendaCooldownDays: 7,
};

describe("advanceState", () => {
	test("moves observing to accumulating_evidence once evidence arrives", () => {
		const result = advanceState(
			baseInput({ status: "observing", evidenceCount: 1 }),
			DEFAULT_MATURATION_POLICY,
		);
		assert.equal(result.status, "accumulating_evidence");
	});

	test("keeps observing when no evidence is present", () => {
		const result = advanceState(baseInput(), DEFAULT_MATURATION_POLICY);
		assert.equal(result.status, "observing");
	});

	test("promotes to candidate_ready when all gates pass", () => {
		const result = advanceState(
			baseInput({
				status: "accumulating_evidence",
				evidenceCount: 3,
				uniqueCount: 3,
				actionableCount: 2,
				observationDays: 3,
				maturityScore: 0.75,
				evidenceStrength: 0.35,
			}),
			FAST_POLICY,
		);
		assert.equal(result.status, "candidate_ready");
	});

	test("continues observing when maturity score is below the threshold", () => {
		const result = advanceState(
			baseInput({
				status: "accumulating_evidence",
				evidenceCount: 3,
				uniqueCount: 3,
				actionableCount: 2,
				observationDays: 3,
				maturityScore: 0.4,
				evidenceStrength: 0.35,
			}),
			FAST_POLICY,
		);
		assert.equal(result.status, "accumulating_evidence");
	});

	test("archives when observation is old and no evidence exists", () => {
		const result = advanceState(
			baseInput({
				status: "accumulating_evidence",
				evidenceCount: 0,
				observationDays: 30,
			}),
			DEFAULT_MATURATION_POLICY,
		);
		assert.equal(result.status, "archived");
	});

	test("surfaces for review when observation exceeds the review window", () => {
		const result = advanceState(
			baseInput({
				status: "accumulating_evidence",
				evidenceCount: 1,
				observationDays: 20,
			}),
			DEFAULT_MATURATION_POLICY,
		);
		assert.equal(result.status, "review_pending");
	});

	test("respects cooldown after a recent surface", () => {
		const result = advanceState(
			baseInput({
				status: "surfaced",
				evidenceCount: 1,
				observationDays: 3,
				lastSurfacedAt: "2026-08-03T00:00:00.000Z",
			}),
			FAST_POLICY,
		);
		assert.equal(result.status, "surfaced");
	});

	test("keeps terminal statuses unchanged", () => {
		for (const terminal of ["resolved", "archived"]) {
			const result = advanceState(
				baseInput({ status: terminal, evidenceCount: 1 }),
				DEFAULT_MATURATION_POLICY,
			);
			assert.equal(result.status, terminal);
		}
	});
});
