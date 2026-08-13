import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { transitionProposal, PROPOSAL_TERMINAL_STATUSES } from "./proposal-state.ts";
import type { ProposalRecord } from "../store/agenda-store.ts";

/** Builds a pending proposal waiting for user approval. */
function pendingProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
	return {
		id: "P-20260805-0001",
		title: "测试提案",
		type: "quality_improvement",
		status: "pending_user_approval",
		evidence: [],
		approval: { required: true, approvedBy: null, approvedAt: null },
		timestamps: {
			createdAt: "2026-08-05T00:00:00.000Z",
			updatedAt: "2026-08-05T00:00:00.000Z",
			expiresAt: "2026-08-06T00:00:00.000Z",
		},
		...overrides,
	};
}

describe("transitionProposal", () => {
	test("advances pending_user_approval to approved", () => {
		const next = transitionProposal(pendingProposal(), "approved", "2026-08-05T01:00:00.000Z");
		assert.equal(next.status, "approved");
		assert.equal(next.timestamps.updatedAt, "2026-08-05T01:00:00.000Z");
	});

	test("advances pending_user_approval to rejected", () => {
		const next = transitionProposal(pendingProposal(), "rejected", "2026-08-05T01:00:00.000Z");
		assert.equal(next.status, "rejected");
	});

	test("advances approved to implemented", () => {
		const next = transitionProposal(
			pendingProposal({ status: "approved" }),
			"implemented",
			"2026-08-05T01:00:00.000Z",
		);
		assert.equal(next.status, "implemented");
	});

	test("advances implemented to verified", () => {
		const next = transitionProposal(
			pendingProposal({ status: "implemented" }),
			"verified",
			"2026-08-05T01:00:00.000Z",
		);
		assert.equal(next.status, "verified");
	});

	test("advances implemented to failed and then to rollback_required", () => {
		const failed = transitionProposal(
			pendingProposal({ status: "implemented" }),
			"failed",
			"2026-08-05T01:00:00.000Z",
		);
		assert.equal(failed.status, "failed");
		const rolledBack = transitionProposal(
			failed,
			"rollback_required",
			"2026-08-05T02:00:00.000Z",
		);
		assert.equal(rolledBack.status, "rollback_required");
	});

	test("rejects an illegal transition", () => {
		assert.throws(
			() => transitionProposal(pendingProposal(), "verified", "2026-08-05T01:00:00.000Z"),
			/illegal transition/i,
		);
	});

	test("rejects a transition from a terminal state", () => {
		for (const status of PROPOSAL_TERMINAL_STATUSES) {
			assert.throws(
				() => transitionProposal(pendingProposal({ status }), "approved", "2026-08-05T01:00:00.000Z"),
				/illegal transition/i,
			);
		}
	});

	test("does not mutate the original proposal", () => {
		const original = pendingProposal();
		const next = transitionProposal(original, "approved", "2026-08-05T01:00:00.000Z");
		assert.equal(original.status, "pending_user_approval");
		assert.equal(next.status, "approved");
	});
});

describe("PROPOSAL_TERMINAL_STATUSES", () => {
	test("contains verified, rejected and rollback_required", () => {
		assert.ok(PROPOSAL_TERMINAL_STATUSES.includes("verified"));
		assert.ok(PROPOSAL_TERMINAL_STATUSES.includes("rejected"));
		assert.ok(PROPOSAL_TERMINAL_STATUSES.includes("rollback_required"));
	});
});
