import type { AgendaMatchers } from "../store/agenda-store.ts";
import {
	classifySignal,
	evidenceWeightForSignal,
} from "../auditor/mapping.ts";
import type { MaturityEvidence } from "../auditor/maturity.ts";

/** Signal record read from signals.jsonl. */
export interface SignalRecord {
	readonly ts: string;
	readonly type: string;
	readonly source: string;
	readonly [key: string]: unknown;
}

/** Maximum weight assigned to one matched evidence. */
const MAX_EVIDENCE_WEIGHT = 0.35;

/** Minimum weight assigned to one matched evidence. */
const MIN_EVIDENCE_WEIGHT = 0.05;

/** Weight increment per matched include keyword. */
const WEIGHT_PER_KEYWORD = 0.05;

/** Matches signals to an agenda item and builds evidence records. */
export function matchSignalsToAgenda(
	signals: readonly SignalRecord[],
	matchers: AgendaMatchers,
	now: string,
): MaturityEvidence[] {
	const evidence: MaturityEvidence[] = [];
	for (const signal of signals) {
		if (!matchesSignal(signal, matchers)) {
			continue;
		}
		const text = JSON.stringify(signal);
		const matchedKeywords = matchers.includeKeywords.filter((keyword) =>
			text.includes(keyword),
		);
		const weight = clampWeight(
			Math.max(
				evidenceWeightForSignal(signal.type),
				matchedKeywords.length * WEIGHT_PER_KEYWORD,
			),
		);
		const classification = classifySignal(signal.type);
		evidence.push({
			at: signal.ts,
			source: signal.type,
			summary: serializeSignalSummary(signal),
			weight,
			qualified: classification.qualified,
			actionable: classification.actionable,
			relevance: signal.type === "feedback" ? 1 : 0.7,
			contribution: 0,
		});
	}
	return evidence;
}

/** Returns true when one signal passes the agenda matcher filters. */
function matchesSignal(
	signal: SignalRecord,
	matchers: AgendaMatchers,
): boolean {
	if (
		matchers.signalTypes.length > 0 &&
		!matchers.signalTypes.includes(signal.type)
	) {
		return false;
	}
	const text = JSON.stringify(signal);
	if (
		matchers.includeKeywords.length > 0 &&
		!matchers.includeKeywords.some((keyword) => text.includes(keyword))
	) {
		return false;
	}
	if (
		matchers.excludeKeywords.length > 0 &&
		matchers.excludeKeywords.some((keyword) => text.includes(keyword))
	) {
		return false;
	}
	return true;
}

/** Clamps an evidence weight into the allowed range. */
function clampWeight(weight: number): number {
	return Math.max(MIN_EVIDENCE_WEIGHT, Math.min(MAX_EVIDENCE_WEIGHT, weight));
}

/** Builds a stable evidence summary from one signal record. */
function serializeSignalSummary(signal: SignalRecord): string {
	const { ts: _ts, type: _type, source: _source, ...rest } = signal;
	return JSON.stringify(rest);
}
