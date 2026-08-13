import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAutoApproval } from "./proposal-approval.ts";
import {
	createAgendaStore,
	type AgendaStore,
	type ProposalRecord,
} from "../store/agenda-store.ts";

/** Creates a store backed by a fresh temporary directory. */
async function createTempStore(): Promise<{ store: AgendaStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pme-p5-"));
	const store = createAgendaStore(dir);
	return { store, dir };
}

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

/** Builds one agent message of either role. */
function message(role: string, content: unknown): Record<string, unknown> {
	return { role, content, timestamp: 1 };
}

describe("runAutoApproval decision capture", () => {
	test("approves a pending proposal when an agent message references its id with an approval keyword", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([pendingProposal()]);
			await runAutoApproval(
				store,
				[message("assistant", "我批准 P-20260805-0001 这个提案")],
				"2026-08-05T12:00:00.000Z",
			);
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "approved");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("rejects a pending proposal when an agent message references its id with a rejection keyword", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([pendingProposal()]);
			await runAutoApproval(
				store,
				[message("assistant", "我拒绝 P-20260805-0001 这个提案")],
				"2026-08-05T12:00:00.000Z",
			);
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "rejected");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("leaves the proposal pending when no message references its id", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([pendingProposal()]);
			await runAutoApproval(
				store,
				[message("assistant", "批准这个提案")],
				"2026-08-05T12:00:00.000Z",
			);
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "pending_user_approval");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("extracts text from structured assistant message content", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([pendingProposal()]);
			await runAutoApproval(
				store,
				[
					message("assistant", [
						{ type: "text", text: "批准 P-20260805-0001" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
					]),
				],
				"2026-08-05T12:00:00.000Z",
			);
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "approved");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("runAutoApproval expiry policy", () => {
	test("rejects a pending proposal whose expiresAt has passed", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([
				pendingProposal({ timestamps: { ...pendingProposal().timestamps, expiresAt: "2026-08-06T00:00:00.000Z" } }),
			]);
			await runAutoApproval(store, [], "2026-08-07T00:00:00.000Z");
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "rejected");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("keeps an unexpired proposal pending when no decision is captured", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeProposalQueue([pendingProposal()]);
			await runAutoApproval(store, [], "2026-08-05T12:00:00.000Z");
			const [proposal] = store.readProposalQueue();
			assert.equal(proposal.status, "pending_user_approval");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("does nothing when the queue is empty", async () => {
		const { store, dir } = await createTempStore();
		try {
			await runAutoApproval(store, [message("assistant", "批准 P-20260805-0001")], "2026-08-05T12:00:00.000Z");
			assert.deepEqual(store.readProposalQueue(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
