import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgendaStore,
	type AgendaCandidate,
	type AgendaStore,
	type ProposalRecord,
	type SpeakDecision,
	type SpeakQuota,
} from "./agenda-store.ts";

/** Creates a store backed by a fresh temporary directory. */
async function createTempStore(): Promise<{ store: AgendaStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pme-p34-"));
	const store = createAgendaStore(dir);
	return { store, dir };
}

/** A minimal candidate. */
function sampleCandidate(): AgendaCandidate {
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

/** A minimal speak decision. */
function sampleDecision(): SpeakDecision {
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

describe("AgendaStore.readCandidates", () => {
	test("returns an empty list when agenda_candidates.yaml does not exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			assert.deepEqual(store.readCandidates(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("round-trips candidates through agenda_candidates.yaml", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeCandidates([sampleCandidate()]);
			const candidates = store.readCandidates();
			assert.equal(candidates.length, 1);
			assert.equal(candidates[0].candidateId, "C-000001");
			assert.equal(candidates[0].maturityScore, 0.78);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore quota read/write", () => {
	test("returns a fresh daily quota when speak_quota.json does not exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			const quota = store.readQuota();
			assert.equal(typeof quota.suggestions, "number");
			assert.equal(typeof quota.strategic, "number");
			assert.ok(quota.date.length > 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("round-trips quota through speak_quota.json on the same day", async () => {
		const { store, dir } = await createTempStore();
		try {
			const today = new Date().toISOString().slice(0, 10);
			const quota: SpeakQuota = { date: today, suggestions: 2, strategic: 1 };
			store.writeQuota(quota);
			const loaded = store.readQuota();
			assert.equal(loaded.date, today);
			assert.equal(loaded.suggestions, 2);
			assert.equal(loaded.strategic, 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("resets quota when the persisted date is stale", async () => {
		const { store, dir } = await createTempStore();
		try {
			const stale: SpeakQuota = {
				date: "2000-01-01",
				suggestions: 3,
				strategic: 1,
			};
			store.writeQuota(stale);
			const loaded = store.readQuota();
			assert.equal(loaded.suggestions, 0);
			assert.equal(loaded.strategic, 0);
			assert.notEqual(loaded.date, "2000-01-01");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore speak decisions", () => {
	test("returns an empty list when no decisions exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			assert.deepEqual(store.readDecisions(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("appends and reads decisions", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.appendDecision(sampleDecision());
			store.appendDecision({ ...sampleDecision(), candidateId: "C-000002" });
			const decisions = store.readDecisions();
			assert.equal(decisions.length, 2);
			assert.equal(decisions[1].candidateId, "C-000002");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore proposal queue", () => {
	test("returns an empty queue when proposal_queue.yaml does not exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			assert.deepEqual(store.readProposalQueue(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("round-trips proposals through proposal_queue.yaml", async () => {
		const { store, dir } = await createTempStore();
		try {
			const proposal: ProposalRecord = {
				id: "P-20260805-0001",
				title: "测试提案",
				type: "quality_improvement",
				status: "draft",
				evidence: [],
				approval: { required: true, approvedBy: null, approvedAt: null },
				timestamps: { createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z" },
			};
			store.writeProposalQueue([proposal]);
			const loaded = store.readProposalQueue();
			assert.equal(loaded.length, 1);
			assert.equal(loaded[0].id, "P-20260805-0001");
			assert.equal(loaded[0].status, "draft");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
