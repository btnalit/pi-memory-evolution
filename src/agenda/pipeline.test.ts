import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgendaStore,
	type AgendaItem,
	type AgendaStore,
} from "../store/agenda-store.ts";
import { runMaturationPipeline } from "./pipeline.ts";
import type { SignalRecord } from "./evidence.ts";

/** Creates a store backed by a fresh temporary directory. */
async function createTempStore(): Promise<{
	store: AgendaStore;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "pme-pipeline-"));
	const store = createAgendaStore(dir);
	return { store, dir };
}

/** Writes signals into the store. */
function seedSignals(
	store: AgendaStore,
	signals: readonly SignalRecord[],
): void {
	for (const signal of signals) {
		store.appendSignal(signal);
	}
}

/** Builds one agenda item. */
function agendaItem(overrides: Partial<AgendaItem> = {}): AgendaItem {
	return {
		id: "A-000001",
		title: "测试议程",
		type: "quality_improvement",
		status: "observing",
		firstSeenAt: "2026-08-01T00:00:00.000Z",
		lastEvidenceAt: "2026-08-01T00:00:00.000Z",
		lastSurfacedAt: null,
		evidence: [],
		counters: {
			evidenceCount: 0,
			observationDays: 1,
			recentMentions7d: 0,
		},
		scores: {
			evidenceStrength: 0,
			trendStrength: 0.5,
			recurrenceDensity: 0,
			unresolvedCost: 0.3,
			actionability: 0.8,
			timePressureBonus: 0,
			stalenessPenalty: 0,
			maturityScore: 0,
		},
		evidenceMatchers: {
			signalTypes: ["feedback"],
			includeKeywords: ["不对"],
			excludeKeywords: [],
		},
		...overrides,
	};
}

describe("runMaturationPipeline", () => {
	test("returns zero results when no signals exist", async () => {
		const { store, dir } = await createTempStore();
		try {
			const result = runMaturationPipeline(store, "2026-08-05T00:00:00.000Z");
			assert.equal(result.evaluatedItems, 0);
			assert.equal(result.newCandidates, 0);
			assert.equal(result.newAgendaProposals, 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("accumulates evidence and advances an agenda item status", async () => {
		const { store, dir } = await createTempStore();
		try {
			store.writeAgenda([agendaItem()]);
			seedSignals(store, [
				{ ts: "2026-08-02T00:00:00.000Z", type: "feedback", source: "turn_end", keywords: ["不对"] },
			]);
			const result = runMaturationPipeline(store, "2026-08-05T00:00:00.000Z");
			assert.equal(result.evaluatedItems, 1);
			const items = store.readAgenda();
			assert.equal(items[0].status, "accumulating_evidence");
			assert.equal(items[0].counters.evidenceCount, 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("writes candidates file in shadow mode for matured items", async () => {
		const { store, dir } = await createTempStore();
		try {
			// A near-mature item: enough observation days and evidence to pass gates.
			store.writeAgenda([
				agendaItem({
					status: "accumulating_evidence",
					firstSeenAt: "2026-07-15T00:00:00.000Z",
					lastEvidenceAt: "2026-08-04T00:00:00.000Z",
					counters: {
						evidenceCount: 3,
						observationDays: 21,
						recentMentions7d: 2,
					},
					evidence: [
						{ at: "2026-08-02T00:00:00.000Z", source: "feedback", summary: "s1", weight: 0.3, qualified: true, actionable: true, relevance: 1, contribution: 0.3 },
						{ at: "2026-08-03T00:00:00.000Z", source: "feedback", summary: "s2", weight: 0.3, qualified: true, actionable: true, relevance: 1, contribution: 0.3 },
						{ at: "2026-08-04T00:00:00.000Z", source: "feedback", summary: "s3", weight: 0.3, qualified: true, actionable: true, relevance: 1, contribution: 0.3 },
					],
				}),
			]);
			seedSignals(store, [
				{ ts: "2026-08-02T00:00:00.000Z", type: "feedback", source: "turn_end", keywords: ["不对"] },
			]);
			const result = runMaturationPipeline(store, "2026-08-05T00:00:00.000Z");
			assert.ok(result.evaluatedItems >= 1);
			const candidates = await readFile(
				join(dir, "agenda_candidates.yaml"),
				"utf8",
			);
			assert.ok(candidates.includes("shadow_mode"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("creates new agenda items from unmatched signal clusters", async () => {
		const { store, dir } = await createTempStore();
		try {
			seedSignals(store, [
				{ ts: "2026-08-01T00:00:00.000Z", type: "projection", source: "agent_end", count: 2 },
				{ ts: "2026-08-02T00:00:00.000Z", type: "projection", source: "agent_end", count: 1 },
				{ ts: "2026-08-03T00:00:00.000Z", type: "projection", source: "agent_end", count: 3 },
			]);
			const result = runMaturationPipeline(store, "2026-08-05T00:00:00.000Z");
			assert.equal(result.newAgendaProposals, 1);
			const items = store.readAgenda();
			assert.equal(items.length, 1);
			assert.equal(items[0].type, "quality_improvement");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("appends an audit line to the journal", async () => {
		const { store, dir } = await createTempStore();
		try {
			runMaturationPipeline(store, "2026-08-05T00:00:00.000Z");
			const journal = await readFile(join(dir, "evolution_journal.md"), "utf8");
			assert.ok(journal.includes("maturation"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
