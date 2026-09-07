import type { DurableMemory, MemoryKind, Source } from "./memory-store.ts";

export type EvidenceBasis = "summary" | "user_statement" | "tool_observation" | "manual_correction";
export interface Evidence {
	basis: EvidenceBasis;
	method: "local" | "model" | "manual";
	sourceId: string;
	at: string;
}
export type FeedbackVerdict = "useful" | "unhelpful" | "accurate" | "incorrect";
export interface FeedbackSignal { verdict: FeedbackVerdict; at: string; sourceId: string }
export interface MemoryFeedback { utility?: FeedbackSignal; accuracy?: FeedbackSignal }
export const FEEDBACK_VERDICTS = new Set<FeedbackVerdict>(["useful", "unhelpful", "accurate", "incorrect"]);
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const identifier = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f]/u.test(v);

export function validEvidence(value: unknown): value is Evidence | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const e = value as Evidence;
	return Object.keys(e).every(k => ["basis", "method", "sourceId", "at"].includes(k))
		&& ["summary", "user_statement", "tool_observation", "manual_correction"].includes(e.basis)
		&& ["local", "model", "manual"].includes(e.method) && identifier(e.sourceId) && date(e.at)
		&& (e.basis === "manual_correction" ? e.method === "manual"
			: e.basis === "summary" ? e.method !== "manual" : e.method === "model");
}
export function validFeedback(value: unknown): value is MemoryFeedback | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.entries(value).every(([key, signal]) => {
		if (!["utility", "accuracy"].includes(key) || !signal || typeof signal !== "object" || Array.isArray(signal)) return false;
		const s = signal as FeedbackSignal;
		return Object.keys(s).every(k => ["verdict", "at", "sourceId"].includes(k)) && date(s.at) && identifier(s.sourceId)
			&& (key === "utility" ? ["useful", "unhelpful"].includes(s.verdict) : ["accurate", "incorrect"].includes(s.verdict));
	});
}
export function sourceEvidence(source: Source, method: "local" | "model"): Evidence {
	return { basis: source.kind === "user" ? "user_statement" : source.kind === "progress" ? "tool_observation" : "summary",
		method, sourceId: source.id, at: source.createdAt };
}

/** An ordinal evidence policy, NOT a probability, verification or model self-confidence.
 * User statements are especially appropriate for preferences, not proof of execution. */
export function evidencePriority(kind: MemoryKind, basis?: EvidenceBasis): number {
	if (basis === "manual_correction") return 4;
	if (basis === "user_statement") return kind === "preference" || kind === "decision" ? 3 : 2;
	if (basis === "tool_observation") return kind === "project_state" ? 3 : 1;
	return basis === "summary" ? 1 : 0;
}
export function mayReplace(old: DurableMemory, incoming: Evidence): boolean {
	const priority = evidencePriority(old.kind, old.evidence?.basis);
	const protectedPriority = old.status === "confirmed" || old.feedback?.accuracy?.verdict === "accurate" ? Math.max(4, priority) : priority;
	// Explicit current user corrections can replace prior manual corrections; summaries cannot.
	return incoming.basis === "user_statement" || (old.kind === "project_state" && incoming.basis === "tool_observation")
		|| evidencePriority(old.kind, incoming.basis) >= protectedPriority;
}

const DAY = 86400_000;
/** No new expiry for stable facts/preferences/decisions and no revival of old states.
 * Floors preserve old useful knowledge; project states retain their seven-day safety cap. */
export const AGING: Record<MemoryKind, { halfLifeDays: number; floor: number; expiresDays?: number }> = {
	project_state: { halfLifeDays: 3, floor: 0.5, expiresDays: 7 },
	fact: { halfLifeDays: 90, floor: 0.75 },
	decision: { halfLifeDays: 180, floor: 0.85 },
	preference: { halfLifeDays: 365, floor: 0.95 },
};
export function memoryQuality(memory: DurableMemory, now = Date.now()) {
	const policy = AGING[memory.kind];
	const ageDays = Math.max(0, (now - Date.parse(memory.updatedAt)) / DAY);
	const pinned = memory.layer === "pinned";
	const freshness = pinned ? 1 : policy.floor + (1 - policy.floor) * 2 ** (-ageDays / policy.halfLifeDays);
	const expired = !pinned && policy.expiresDays !== undefined && ageDays > policy.expiresDays;
	const basis = memory.evidence?.basis ?? "unknown";
	const priority = evidencePriority(memory.kind, memory.evidence?.basis);
	const evidenceWeight = 1 + priority * 0.04;
	// Last explicit verdict wins, not frequency. Usefulness never increases evidence priority.
	const utility = memory.feedback?.utility?.verdict === "useful" ? 1.05 : memory.feedback?.utility?.verdict === "unhelpful" ? 0.9 : 1;
	const accuracy = memory.feedback?.accuracy?.verdict === "accurate" ? 1.05 : memory.feedback?.accuracy?.verdict === "incorrect" ? 0.5 : 1;
	return { basis, method: memory.evidence?.method ?? "unknown", ageDays, freshness, expired,
		evidenceWeight, utility, accuracy, factor: freshness * evidenceWeight * utility * accuracy };
}
