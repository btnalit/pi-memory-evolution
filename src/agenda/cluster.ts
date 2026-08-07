import type { AgendaItem, AgendaMatchers } from "../store/agenda-store.ts";
import type { SignalRecord } from "./evidence.ts";

/** Minimum signals in one cluster to qualify as a new agenda proposal. */
const MIN_CLUSTER_SIGNALS = 3;

/** Minimum days between first and last signal in a qualifying cluster. */
const MIN_DISTINCT_DAYS = 2;

/** Signals grouped by a shared type. */
export interface SignalCluster {
	readonly type: string;
	readonly signalCount: number;
	readonly firstTs: string;
	readonly lastTs: string;
}

/** New agenda item proposed from a recurring unmatched signal cluster. */
export interface NewAgendaProposal {
	readonly title: string;
	readonly type: string;
	readonly evidenceMatchers: AgendaMatchers;
}

/** Returns signals that match none of the existing agenda items. */
export function findUnmatchedSignals(
	signals: readonly SignalRecord[],
	agendaItems: readonly AgendaItem[],
): SignalRecord[] {
	if (agendaItems.length === 0) {
		return [...signals];
	}
	return signals.filter((signal) =>
		agendaItems.every((item) => !matchesItem(signal, item)),
	);
}

/** Groups unmatched signals into clusters by type. */
export function clusterSignals(
	signals: readonly SignalRecord[],
): SignalCluster[] {
	const byType = new Map<string, SignalRecord[]>();
	for (const signal of signals) {
		const group = byType.get(signal.type);
		if (group === undefined) {
			byType.set(signal.type, [signal]);
		} else {
			group.push(signal);
		}
	}

	const clusters: SignalCluster[] = [];
	for (const [type, group] of byType) {
		if (group.length < MIN_CLUSTER_SIGNALS) {
			continue;
		}
		const timestamps = group.map((item) => item.ts).sort();
		clusters.push({
			type,
			signalCount: group.length,
			firstTs: timestamps[0],
			lastTs: timestamps[timestamps.length - 1],
		});
	}
	return clusters;
}

/** Creates a new agenda proposal when a cluster meets all thresholds. */
export function proposeNewAgenda(
	cluster: SignalCluster,
	now: string,
): NewAgendaProposal | undefined {
	const distinctDays = daysBetween(cluster.firstTs, cluster.lastTs);
	if (cluster.signalCount < MIN_CLUSTER_SIGNALS) {
		return undefined;
	}
	if (distinctDays < MIN_DISTINCT_DAYS) {
		return undefined;
	}
	void now;
	return {
		title: `自动发现：${cluster.type} 信号重复出现`,
		type: "quality_improvement",
		evidenceMatchers: {
			signalTypes: [cluster.type],
			includeKeywords: [],
			excludeKeywords: [],
		},
	};
}

/** Returns true when one signal matches one agenda item's matchers. */
function matchesItem(signal: SignalRecord, item: AgendaItem): boolean {
	const matchers = item.evidenceMatchers;
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

/** Returns whole days between two ISO timestamps. */
function daysBetween(isoStart: string, isoEnd: string): number {
	const startMs = Date.parse(isoStart);
	const endMs = Date.parse(isoEnd);
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
		return 0;
	}
	return Math.max(0, Math.floor((endMs - startMs) / 86_400_000));
}
