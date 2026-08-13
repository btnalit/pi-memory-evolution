import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeApprovedProposals } from "./proposal-executor.ts";
import {
	createAgendaStore,
	type AgendaStore,
	type ProposalRecord,
} from "../store/agenda-store.ts";

/** Creates a store backed by a fresh temporary directory. */
async function createTempStore(): Promise<{ store: AgendaStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pme-exec-"));
	const store = createAgendaStore(dir);
	return { store, dir };
}

/** Builds an approved proposal ready for execution. */
function approvedProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
	return {
		id: "P-20260805-0001",
		title: "测试提案",
		type: "quality_improvement",
		status: "approved",
		evidence: [
			{
				at: "2026-08-04T00:00:00.000Z",
				source: "feedback",
				summary: "test evidence",
				weight: 0.3,
				qualified: true,
				actionable: true,
				relevance: 1,
				contribution: 0.3,
			},
		],
		approval: { required: true, approvedBy: "agent", approvedAt: "2026-08-05T00:00:00.000Z" },
		timestamps: {
			createdAt: "2026-08-05T00:00:00.000Z",
			updatedAt: "2026-08-05T00:00:00.000Z",
			expiresAt: "2026-08-06T00:00:00.000Z",
		},
		...overrides,
	};
}

describe("executeApprovedProposals", () => {
	test("writes an execution plan and advances the proposal to implemented", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([approvedProposal()]);
			executeApprovedProposals(store, "2026-08-05T12:00:00.000Z");
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "implemented");
			const plan = store.readExecutionPlan("P-20260805-0001");
			assert.ok(plan !== undefined);
			assert.ok(plan.includes("测试提案"));
			assert.ok(plan.toLowerCase().includes("rollback"));
			assert.ok(plan.toLowerCase().includes("verification"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("keeps non-approved proposals untouched", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([
				approvedProposal({ id: "P-20260805-0002", status: "pending_user_approval" }),
			]);
			executeApprovedProposals(store, "2026-08-05T12:00:00.000Z");
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "pending_user_approval");
			assert.equal(store.readExecutionPlan("P-20260805-0002"), undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("does nothing when the queue is empty", async () => {
		const { store, dir } = await createTempStore();
		try {
			executeApprovedProposals(store, "2026-08-05T12:00:00.000Z");
			assert.deepEqual(store.readProposalQueue(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("marks a proposal failed when its execution plan cannot be written", async () => {
		const { store, dir } = await createTempStore();
		try {
			// An unsafe proposal id (path traversal) is rejected by the executor.
			store.writeProposalQueue([
				approvedProposal({ id: "../evil" }),
			]);
			executeApprovedProposals(store, "2026-08-05T12:00:00.000Z");
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "failed");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("continues with remaining proposals when one fails", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([
				approvedProposal({ id: "../evil" }),
				approvedProposal({ id: "P-20260805-0002" }),
			]);
			executeApprovedProposals(store, "2026-08-05T12:00:00.000Z");
			const [bad, good] = store.readProposalQueue();
			assert.equal(bad.status, "failed");
			assert.equal(good.status, "implemented");
			assert.ok(store.readExecutionPlan("P-20260805-0002") !== undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
