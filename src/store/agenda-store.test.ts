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
				status: "pending_user_approval",
				evidence: [],
				approval: { required: true, approvedBy: null, approvedAt: null },
				timestamps: {
					createdAt: "2026-08-05T00:00:00.000Z",
					updatedAt: "2026-08-05T00:00:00.000Z",
					expiresAt: "2026-08-06T00:00:00.000Z",
				},
			};
			store.writeProposalQueue([proposal]);
			const loaded = store.readProposalQueue();
			assert.equal(loaded.length, 1);
			assert.equal(loaded[0].id, "P-20260805-0001");
			assert.equal(loaded[0].status, "pending_user_approval");
			assert.equal(loaded[0].timestamps.expiresAt, "2026-08-06T00:00:00.000Z");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore execution plans", () => {
	test("returns undefined when an execution plan does not exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			assert.equal(store.readExecutionPlan("P-20260805-0001"), undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("round-trips an execution plan through executions/", async () => {
		const { store, dir } = await createTempStore();
		try {
			const markdown = "# Execution Plan\n\n- proposal: P-20260805-0001\n";
			store.writeExecutionPlan("P-20260805-0001", markdown);
			const loaded = store.readExecutionPlan("P-20260805-0001");
			assert.equal(loaded, markdown);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore execution plan archive", () => {
	test("moves an execution plan into executions/archive/", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeExecutionPlan("P-20260805-0001", "# plan");
			const moved = store.archiveExecutionPlan("P-20260805-0001");
			assert.equal(moved, true);
			assert.equal(store.readExecutionPlan("P-20260805-0001"), undefined);
			assert.ok(store.readArchivedPlan("P-20260805-0001") !== undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns false when there is no plan to archive", async () => {
		const { store, dir } = await createTempStore();
		try {
			assert.equal(store.archiveExecutionPlan("P-20260805-0001"), false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("purges only archived plans older than the retention window", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeExecutionPlan("P-20260805-0001", "# old");
			store.writeExecutionPlan("P-20260805-0002", "# fresh");
			store.archiveExecutionPlan("P-20260805-0001");
			store.archiveExecutionPlan("P-20260805-0002");
			const now = "2026-08-05T00:00:00.000Z";
			// 1 day ago is within the window; 100 days ago is beyond it.
			const oldPath = join(dir, "executions", "archive", "P-20260805-0001.md");
			const oldTime = Date.parse(now) - 100 * 24 * 3_600_000;
			const { utimes } = await import("node:fs/promises");
			await utimes(oldPath, new Date(oldTime), new Date(oldTime));
			const purged = store.purgeExpiredArchives(now, 90);
			assert.equal(purged, 1);
			assert.equal(store.readArchivedPlan("P-20260805-0001"), undefined);
			assert.ok(store.readArchivedPlan("P-20260805-0002") !== undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore speak thresholds", () => {
	test("returns Hermes defaults when thresholds.json does not exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			const thresholds = store.readThresholds();
			assert.equal(thresholds.speakThreshold, 0.6);
			assert.equal(thresholds.priorityQueueThreshold, 0.6);
			assert.equal(thresholds.dailyDigestThreshold, 0.4);
			assert.equal(thresholds.suggestionLimit, 3);
			assert.equal(thresholds.strategicLimit, 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("round-trips custom thresholds through thresholds.json", async () => {
		const { store, dir } = await createTempStore();
		try {
			const custom = {
				speakThreshold: 0.5,
				priorityQueueThreshold: 0.55,
				dailyDigestThreshold: 0.35,
				suggestionLimit: 5,
				strategicLimit: 2,
			};
			store.writeThresholds(custom);
			const loaded = store.readThresholds();
			assert.deepEqual(loaded, custom);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
