import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { buildRuntimeDigest, type DigestInput } from "./digest.ts";
import type {
	AgendaCandidate,
	SpeakDecision,
} from "../store/agenda-store.ts";

/** Builds a digest input with no candidates or decisions. */
function baseInput(overrides: Partial<DigestInput> = {}): DigestInput {
	return {
		now: "2026-08-13T04:00:00.000Z",
		candidates: [],
		decisions: [],
		...overrides,
	};
}

/** Builds one candidate awaiting decision. */
function pendingCandidate(): AgendaCandidate {
	return {
		candidateId: "C-000001",
		agendaId: "A-000001",
		title: "测试候选",
		type: "quality_improvement",
		maturityScore: 0.78,
		action: "create_proposal",
		status: "candidate_ready",
		evidenceCount: 3,
		observationDays: 4,
		suggestedMessage: "议题：测试候选",
	};
}

/** Builds one approved decision. */
function approvedDecision(): SpeakDecision {
	return {
		candidateId: "C-000001",
		title: "测试候选",
		priorityScore: 0.7,
		speakScore: 0.65,
		action: "speak_now",
		wouldHaveSpokenWithoutQuota: false,
		decisionReason: ["weighted = 0.7"],
	};
}

describe("buildRuntimeDigest", () => {
	test("returns undefined when there is nothing to report", () => {
		const digest = buildRuntimeDigest(baseInput());
		assert.equal(digest, undefined);
	});

	test("includes a pending candidate section", () => {
		const digest = buildRuntimeDigest(
			baseInput({ candidates: [pendingCandidate()] }),
		);
		assert.ok(digest !== undefined);
		assert.ok(digest.includes("测试候选"));
		assert.ok(digest.includes("advisory"));
	});

	test("includes recent speak decisions", () => {
		const digest = buildRuntimeDigest(
			baseInput({ decisions: [approvedDecision()] }),
		);
		assert.ok(digest !== undefined);
		assert.ok(digest.includes("speak_now"));
	});

	test("stays below the 2KB budget", () => {
		const digest = buildRuntimeDigest(
			baseInput({
				candidates: [pendingCandidate()],
				decisions: [approvedDecision()],
			}),
		);
		assert.ok(digest !== undefined);
		assert.ok(digest.length < 2048, `digest too large: ${digest.length}`);
	});

	test("carries a Valid until timestamp", () => {
		const digest = buildRuntimeDigest(
			baseInput({ candidates: [pendingCandidate()] }),
		);
		assert.ok(digest !== undefined);
		assert.ok(digest.includes("Valid until: 2026-08-14"));
	});

	test("omits the focus section when no candidate or decision exists", () => {
		const digest = buildRuntimeDigest(baseInput());
		assert.equal(digest, undefined);
	});
});
