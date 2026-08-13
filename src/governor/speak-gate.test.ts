import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	evaluateCandidate,
	type SpeakGateInput,
} from "./speak-gate.ts";
import type { AgendaCandidate } from "../store/agenda-store.ts";

/** Builds a candidate with high maturity. */
function strongCandidate(): AgendaCandidate {
	return {
		candidateId: "C-000001",
		agendaId: "A-000001",
		title: "强候选",
		type: "quality_improvement",
		maturityScore: 0.85,
		action: "create_proposal",
		status: "candidate_ready",
		evidenceCount: 5,
		observationDays: 10,
		suggestedMessage: "议题：强候选",
	};
}

/** Builds a speak gate input with defaults. */
function baseInput(overrides: Partial<SpeakGateInput> = {}): SpeakGateInput {
	return {
		candidate: strongCandidate(),
		quota: { date: "2026-08-13", suggestions: 0, strategic: 0 },
		...overrides,
	};
}

describe("evaluateCandidate", () => {
	test("returns speak_now for a strong candidate with low risk", () => {
		const result = evaluateCandidate(baseInput());
		assert.equal(result.decision.action, "speak_now");
		assert.ok(result.decision.priorityScore >= 0.6);
		assert.ok(result.decision.speakScore >= 0.6);
	});

	test("returns speak_now_with_approval for medium risk with a very strong candidate", () => {
		const result = evaluateCandidate(
			baseInput({
				candidate: {
					...strongCandidate(),
					maturityScore: 0.98,
					evidenceCount: 5,
				},
				riskLevel: "medium",
			}),
		);
		// weighted = 0.98*0.4 + 1.0*0.25 + 0.98*0.35 = 0.985; x0.82 = 0.8077;
		// speak = 0.8077 - 0.2 = 0.6077 >= 0.6 and actionability >= 0.6 → with approval
		assert.equal(result.decision.action, "speak_now_with_approval");
	});

	test("returns speak_now_risk_alert for urgent candidates", () => {
		const result = evaluateCandidate(
			baseInput({ urgent: true }),
		);
		assert.equal(result.decision.action, "speak_now_risk_alert");
	});

	test("returns risk_alert_only for critical risk", () => {
		const result = evaluateCandidate(
			baseInput({ riskLevel: "critical" }),
		);
		assert.equal(result.decision.action, "risk_alert_only");
	});

	test("returns daily_digest for a weak candidate", () => {
		const weak = evaluateCandidate(
			baseInput({
				candidate: { ...strongCandidate(), maturityScore: 0.5, evidenceCount: 1 },
			}),
		);
		assert.equal(weak.decision.action, "daily_digest");
	});

	test("returns proposal_queue for a medium candidate below speak threshold", () => {
		const medium = evaluateCandidate(
			baseInput({
				candidate: { ...strongCandidate(), maturityScore: 0.65, evidenceCount: 2 },
			}),
		);
		assert.equal(medium.decision.action, "proposal_queue");
	});

	test("returns silent_log_only for a very weak candidate", () => {
		const silent = evaluateCandidate(
			baseInput({
				candidate: {
					...strongCandidate(),
					maturityScore: 0.2,
					evidenceCount: 0,
					observationDays: 1,
				},
			}),
		);
		assert.equal(silent.decision.action, "silent_log_only");
	});

	test("downgrades to proposal_queue when suggestion quota is exhausted", () => {
		const result = evaluateCandidate(
			baseInput({
				quota: { date: "2026-08-13", suggestions: 3, strategic: 0 },
			}),
		);
		assert.equal(result.decision.action, "proposal_queue");
		assert.equal(result.decision.wouldHaveSpokenWithoutQuota, true);
	});

	test("downgrades strategic to proposal_queue when strategic quota is exhausted", () => {
		const result = evaluateCandidate(
			baseInput({
				candidate: { ...strongCandidate(), type: "strategic_positioning" },
				quota: { date: "2026-08-13", suggestions: 0, strategic: 1 },
			}),
		);
		assert.equal(result.decision.action, "proposal_queue");
		assert.equal(result.decision.wouldHaveSpokenWithoutQuota, true);
	});

	test("consumes quota when speaking", () => {
		const result = evaluateCandidate(baseInput());
		assert.equal(result.quota.suggestions, 1);
		assert.equal(result.quotaConsumed, true);
	});

	test("does not consume quota for proposal_queue", () => {
		const result = evaluateCandidate(
			baseInput({
				candidate: { ...strongCandidate(), maturityScore: 0.65, evidenceCount: 2 },
			}),
		);
		assert.equal(result.quotaConsumed, false);
		assert.equal(result.quota.suggestions, 0);
	});

	test("emits a traceable decision_reason", () => {
		const result = evaluateCandidate(baseInput());
		assert.ok(result.decision.decisionReason.length >= 4);
		assert.ok(
			result.decision.decisionReason.some((line) =>
				line.includes("priority"),
			),
		);
	});
});
