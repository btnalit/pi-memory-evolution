import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	createProposalFromCandidate,
	type ProposalDraft,
} from "./proposal-queue.ts";
import type { AgendaCandidate, AgendaEvidence } from "../store/agenda-store.ts";

/** Builds an approved candidate. */
function approvedCandidate(): AgendaCandidate {
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

/** Builds one evidence record for the proposal. */
function evidenceItem(): AgendaEvidence {
	return {
		at: "2026-08-05T00:00:00.000Z",
		source: "feedback",
		summary: "test evidence",
		weight: 0.3,
		qualified: true,
		actionable: true,
		relevance: 1,
		contribution: 0.3,
	};
}

describe("createProposalFromCandidate", () => {
	test("creates a pending proposal awaiting user approval", () => {
		const proposal = createProposalFromCandidate(
			approvedCandidate(),
			[evidenceItem()],
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(proposal.status, "pending_user_approval");
		assert.equal(proposal.title, "测试候选");
		assert.equal(proposal.type, "quality_improvement");
		assert.ok(proposal.id.startsWith("P-"));
	});

	test("requires approval and leaves approval fields null until decided", () => {
		const proposal = createProposalFromCandidate(
			approvedCandidate(),
			[evidenceItem()],
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(proposal.approval.required, true);
		assert.equal(proposal.approval.approvedBy, null);
		assert.equal(proposal.approval.approvedAt, null);
	});

	test("sets an expiry 24 hours after creation", () => {
		const proposal = createProposalFromCandidate(
			approvedCandidate(),
			[],
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(proposal.timestamps.expiresAt, "2026-08-06T00:00:00.000Z");
	});

	test("carries candidate evidence into the proposal", () => {
		const proposal = createProposalFromCandidate(
			approvedCandidate(),
			[evidenceItem()],
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(proposal.evidence.length, 1);
		assert.equal(proposal.evidence[0].summary, "test evidence");
	});

	test("sets created and updated timestamps", () => {
		const proposal = createProposalFromCandidate(
			approvedCandidate(),
			[],
			"2026-08-05T00:00:00.000Z",
		);
		assert.equal(proposal.timestamps.createdAt, "2026-08-05T00:00:00.000Z");
		assert.equal(proposal.timestamps.updatedAt, "2026-08-05T00:00:00.000Z");
	});

	test("generates unique proposal ids", () => {
		const a = createProposalFromCandidate(approvedCandidate(), [], "2026-08-05T00:00:00.000Z");
		const b = createProposalFromCandidate(approvedCandidate(), [], "2026-08-05T00:00:00.000Z");
		assert.notEqual(a.id, b.id);
	});
});

describe("ProposalDraft shape", () => {
	test("matches the persisted ProposalRecord fields", () => {
		const proposal: ProposalDraft = createProposalFromCandidate(
			approvedCandidate(),
			[],
			"2026-08-05T00:00:00.000Z",
		);
		// The draft is structurally compatible with the store's ProposalRecord.
		const { id, title, type, status, evidence, approval, timestamps } =
			proposal;
		assert.ok(id.length > 0);
		assert.equal(typeof title, "string");
		assert.equal(typeof type, "string");
		assert.equal(status, "pending_user_approval");
		assert.ok(Array.isArray(evidence));
		assert.equal(typeof approval.required, "boolean");
		assert.equal(typeof timestamps.createdAt, "string");
	});
});
