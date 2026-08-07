import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	clusterSignals,
	findUnmatchedSignals,
	proposeNewAgenda,
	type NewAgendaProposal,
	type SignalCluster,
} from "./cluster.ts";
import type { AgendaItem } from "../store/agenda-store.ts";
import type { SignalRecord } from "./evidence.ts";

/** Builds a signal record. */
function signal(
	overrides: Partial<SignalRecord> = {},
): SignalRecord {
	return {
		ts: "2026-08-05T00:00:00.000Z",
		type: "feedback",
		source: "turn_end",
		...overrides,
	};
}

/** Builds an agenda item that matches feedback signals. */
function agendaMatchingFeedback(): AgendaItem {
	return {
		id: "A-000001",
		title: "反馈质量",
		type: "quality_improvement",
		status: "observing",
		firstSeenAt: "2026-08-01T00:00:00.000Z",
		lastEvidenceAt: "2026-08-01T00:00:00.000Z",
		lastSurfacedAt: null,
		evidence: [],
		counters: { evidenceCount: 0, observationDays: 1, recentMentions7d: 0 },
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
	};
}

describe("findUnmatchedSignals", () => {
	test("returns signals that match no agenda item", () => {
		const signals = [
			signal({ type: "feedback", keywords: ["不对"] }), // matched by agenda
			signal({ type: "projection", count: 2 }), // unmatched
		];
		const unmatched = findUnmatchedSignals(signals, [agendaMatchingFeedback()]);
		assert.equal(unmatched.length, 1);
		assert.equal(unmatched[0].type, "projection");
	});

	test("returns all signals when no agenda items exist", () => {
		const signals = [signal({ type: "feedback" })];
		const unmatched = findUnmatchedSignals(signals, []);
		assert.equal(unmatched.length, 1);
	});
});

describe("clusterSignals", () => {
	test("groups unmatched signals by type", () => {
		const clusters = clusterSignals([
			signal({ type: "projection", ts: "2026-08-01T00:00:00.000Z" }),
			signal({ type: "projection", ts: "2026-08-02T00:00:00.000Z" }),
			signal({ type: "projection", ts: "2026-08-03T00:00:00.000Z" }),
			signal({ type: "session_stats", ts: "2026-08-01T00:00:00.000Z" }),
			signal({ type: "session_stats", ts: "2026-08-02T00:00:00.000Z" }),
			signal({ type: "session_stats", ts: "2026-08-03T00:00:00.000Z" }),
		]);
		assert.equal(clusters.length, 2);
		const projectionCluster = clusters.find(
			(cluster) => cluster.type === "projection",
		);
		assert.ok(projectionCluster !== undefined);
		assert.equal(projectionCluster.signalCount, 3);
	});

	test("ignores clusters below the minimum signal count", () => {
		const clusters = clusterSignals([
			signal({ type: "projection", ts: "2026-08-01T00:00:00.000Z" }),
		]);
		assert.deepEqual(clusters, []);
	});
});

describe("proposeNewAgenda", () => {
	test("creates a proposal for a cluster meeting thresholds", () => {
		const cluster: SignalCluster = {
			type: "projection",
			signalCount: 3,
			firstTs: "2026-08-01T00:00:00.000Z",
			lastTs: "2026-08-03T00:00:00.000Z",
		};
		const proposal = proposeNewAgenda(cluster, "2026-08-05T00:00:00.000Z");
		assert.ok(proposal !== undefined);
		assert.equal(proposal.type, "quality_improvement");
		assert.equal(proposal.evidenceMatchers.signalTypes[0], "projection");
	});

	test("returns undefined for a sparse cluster below thresholds", () => {
		const cluster: SignalCluster = {
			type: "projection",
			signalCount: 2,
			firstTs: "2026-08-01T00:00:00.000Z",
			lastTs: "2026-08-01T00:00:00.000Z",
		};
		const proposal = proposeNewAgenda(cluster, "2026-08-05T00:00:00.000Z");
		assert.equal(proposal, undefined);
	});
});

describe("NewAgendaProposal shape", () => {
	test("carries a suggested title and matchers", () => {
		const cluster: SignalCluster = {
			type: "feedback",
			signalCount: 3,
			firstTs: "2026-08-01T00:00:00.000Z",
			lastTs: "2026-08-03T00:00:00.000Z",
		};
		const proposal = proposeNewAgenda(cluster, "2026-08-05T00:00:00.000Z") as
			| NewAgendaProposal
			| undefined;
		assert.ok(proposal !== undefined);
		assert.ok(proposal.title.length > 0);
		assert.ok(proposal.evidenceMatchers.includeKeywords.length >= 0);
	});
});
