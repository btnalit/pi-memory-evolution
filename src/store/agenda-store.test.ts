import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgendaStore,
	type AgendaItem,
	type AgendaStore,
} from "./agenda-store.ts";

/** Creates a store backed by a fresh temporary directory. */
async function createTempStore(): Promise<{ store: AgendaStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pme-agenda-"));
	const store = createAgendaStore(dir);
	return { store, dir };
}

/** A minimal valid agenda item. */
function sampleAgendaItem(): AgendaItem {
	return {
		id: "A-000001",
		title: "检测投影重跑模式",
		type: "quality_improvement",
		status: "observing",
		firstSeenAt: "2026-08-05T00:00:00.000Z",
		lastEvidenceAt: "2026-08-05T00:00:00.000Z",
		lastSurfacedAt: null,
		evidence: [],
		counters: {
			evidenceCount: 0,
			observationDays: 1,
			recentMentions7d: 0,
		},
		scores: {
			evidenceStrength: 0.0,
			trendStrength: 0.5,
			recurrenceDensity: 0.0,
			unresolvedCost: 0.3,
			actionability: 0.8,
			timePressureBonus: 0.0,
			stalenessPenalty: 0.0,
			maturityScore: 0.0,
		},
		evidenceMatchers: {
			signalTypes: ["projection"],
			includeKeywords: ["重跑"],
			excludeKeywords: [],
		},
	};
}

describe("AgendaStore.readSignals", () => {
	test("returns an empty list when signals.jsonl does not exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			assert.deepEqual(store.readSignals(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("parses existing JSONL signal records", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.appendSignal({ ts: "t1", type: "session_stats", source: "agent_end" });
			store.appendSignal({ ts: "t2", type: "projection", source: "agent_end", count: 2 });
			const signals = store.readSignals();
			assert.equal(signals.length, 2);
			assert.equal(signals[1].type, "projection");
			assert.equal(signals[1].count, 2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore.readAgenda / writeAgenda", () => {
	test("returns an empty list when self_agenda.yaml does not exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			assert.deepEqual(store.readAgenda(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("round-trips agenda items through self_agenda.yaml", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeAgenda([sampleAgendaItem()]);
			const items = store.readAgenda();
			assert.equal(items.length, 1);
			assert.equal(items[0].id, "A-000001");
			assert.equal(items[0].type, "quality_improvement");
			assert.equal(items[0].status, "observing");
			assert.equal(items[0].scores.maturityScore, 0);
			assert.equal(items[0].counters.evidenceCount, 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("overwrites the agenda file on write", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeAgenda([sampleAgendaItem()]);
			store.writeAgenda([]);
			assert.deepEqual(store.readAgenda(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore.writeCandidates", () => {
	test("writes agenda_candidates.yaml with version and shadow mode", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeCandidates([
				{
					candidateId: "C-000001",
					agendaId: "A-000001",
					title: "候选",
					type: "quality_improvement",
					maturityScore: 0.78,
					action: "create_proposal",
					status: "candidate_ready",
					evidenceCount: 3,
					observationDays: 4,
					suggestedMessage: "测试候选",
				},
			]);
			const content = await readFile(join(dir, "agenda_candidates.yaml"), "utf8");
			assert.ok(content.includes("version"));
			assert.ok(content.includes("shadow_mode"));
			assert.ok(content.includes("C-000001"));
			assert.ok(content.includes("0.78"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgendaStore.appendJournal", () => {
	test("appends audit lines to evolution_journal.md", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.appendJournal("- audit line");
			const content = await readFile(join(dir, "evolution_journal.md"), "utf8");
			assert.ok(content.includes("audit line"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
