import type {
	AgendaItem,
	AgendaStore,
} from "../store/agenda-store.ts";
import { computeScores } from "../auditor/maturity.ts";
import { matchSignalsToAgenda, type SignalRecord } from "./evidence.ts";
import { advanceState, DEFAULT_MATURATION_POLICY } from "./engine.ts";
import {
	clusterSignals,
	findUnmatchedSignals,
	proposeNewAgenda,
} from "./cluster.ts";

/** Outcome summary of one maturation pipeline run. */
export interface PipelineResult {
	readonly evaluatedItems: number;
	readonly newCandidates: number;
	readonly newAgendaProposals: number;
}

/** Runs one maturation pass over signals and agenda in shadow mode. */
export function runMaturationPipeline(
	store: AgendaStore,
	now: string,
): PipelineResult {
	const signals = store.readSignals();
	let agenda = store.readAgenda();
	let evaluatedItems = 0;
	let newCandidates = 0;
	let newAgendaProposals = 0;

	const matured: AgendaItem[] = [];
	for (const item of agenda) {
		const evidence = matchSignalsToAgenda(
			signals,
			item.evidenceMatchers,
			now,
		);
		const mergedEvidence = mergeEvidence(item.evidence, evidence);
		const uniqueCount = countUniqueSources(mergedEvidence);
		const actionableCount = mergedEvidence.filter((e) => e.actionable).length;
		const observationDays = daysBetween(item.firstSeenAt, now);
		const scores = computeScores({
			evidence: mergedEvidence,
			uniqueCount,
			observationDays,
			recentMentions7d: item.counters.recentMentions7d,
			unresolvedCost: item.scores.unresolvedCost,
			type: item.type,
			now,
		});
		const advanced = advanceState(
			{
				status: item.status,
				evidenceCount: mergedEvidence.length,
				uniqueCount,
				actionableCount,
				observationDays,
				maturityScore: scores.maturityScore,
				evidenceStrength: scores.evidenceStrength,
				lastSurfacedAt: item.lastSurfacedAt,
				now,
			},
			DEFAULT_MATURATION_POLICY,
		);

		const updated: AgendaItem = {
			...item,
			status: advanced.status,
			evidence: mergedEvidence,
			lastEvidenceAt:
				mergedEvidence.length > 0
					? mergedEvidence[mergedEvidence.length - 1].at
					: item.lastEvidenceAt,
			counters: {
				...item.counters,
				evidenceCount: mergedEvidence.length,
				observationDays,
			},
			scores,
		};
		matured.push(updated);
		evaluatedItems += 1;
		if (advanced.status === "candidate_ready") {
			newCandidates += 1;
		}
	}

	const proposals = proposeAgendaFromUnmatched(signals, matured, now);
	agenda = [...matured, ...proposals];
	newAgendaProposals = proposals.length;

	store.writeAgenda(agenda);
	writeCandidates(store, matured);
	store.appendJournal(
		`- ${now} maturation run: ${evaluatedItems} items, ${newCandidates} candidates, ${newAgendaProposals} new agenda`,
	);

	return { evaluatedItems, newCandidates, newAgendaProposals };
}

/** Merges existing and newly matched evidence, dropping duplicates by source+summary. */
function mergeEvidence(
	existing: AgendaItem["evidence"],
	fresh: AgendaItem["evidence"],
): AgendaItem["evidence"] {
	const seen = new Set(
		existing.map((item) => `${item.source}:${item.summary}`),
	);
	const merged = [...existing];
	for (const item of fresh) {
		const key = `${item.source}:${item.summary}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		merged.push(item);
	}
	return merged;
}

/** Counts evidence records with distinct source+summary pairs. */
function countUniqueSources(
	evidence: AgendaItem["evidence"],
): number {
	return new Set(evidence.map((item) => `${item.source}:${item.summary}`)).size;
}

/** Creates new agenda items from unmatched signal clusters. */
function proposeAgendaFromUnmatched(
	signals: readonly SignalRecord[],
	agenda: readonly AgendaItem[],
	now: string,
): AgendaItem[] {
	const unmatched = findUnmatchedSignals(signals, agenda);
	const clusters = clusterSignals(unmatched);
	const proposals: AgendaItem[] = [];
	for (const cluster of clusters) {
		const proposal = proposeNewAgenda(cluster, now);
		if (proposal === undefined) {
			continue;
		}
		proposals.push({
			id: `A-${Date.now()}-${proposals.length}`,
			title: proposal.title,
			type: proposal.type,
			status: "observing",
			firstSeenAt: now,
			lastEvidenceAt: now,
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
			evidenceMatchers: proposal.evidenceMatchers,
		});
	}
	return proposals;
}

/** Writes matured candidates to the shadow-mode candidates file. */
function writeCandidates(
	store: AgendaStore,
	agenda: readonly AgendaItem[],
): void {
	store.writeCandidates(
		agenda
			.filter((item) => item.status === "candidate_ready")
			.map((item) => ({
				candidateId: `C-${item.id}`,
				agendaId: item.id,
				title: item.title,
				type: item.type,
				maturityScore: item.scores.maturityScore,
				action:
					item.type === "strategic_positioning"
						? "ask_user_confirmation"
						: "create_proposal",
				status: "candidate_ready",
				evidenceCount: item.counters.evidenceCount,
				observationDays: item.counters.observationDays,
				suggestedMessage: `议题：${item.title}`,
				evidence: item.evidence,
			})),
	);
}

/** Returns whole days between an ISO timestamp and a reference epoch. */
function daysBetween(isoAt: string, nowMs: string): number {
	const atMs = Date.parse(isoAt);
	const refMs = Date.parse(nowMs);
	if (Number.isNaN(atMs) || Number.isNaN(refMs)) {
		return 0;
	}
	return Math.max(0, Math.floor((refMs - atMs) / 86_400_000));
}
