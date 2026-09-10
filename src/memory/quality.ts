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
/** Age is not evidence of falsity. A preference nobody has restated in a year is almost certainly
 * still true, and a fact nobody has restated in three months might be false — age alone cannot tell
 * them apart, so time never deletes anything here. Only contradicting evidence does, through
 * `replaces`. What time does is stop a record being *offered*: past `dormantDays` it is no longer
 * injected, while staying stored, recallable on request and eligible as a replacement candidate, so
 * a source that mentions it again revives it with no human step. See `reinforcedAt`.
 *
 * The horizons are reasoned, not fitted - the store is far too young to fit them to. A statement
 * about in-flight work is worthless after a week. An environment fact nobody has confirmed in half
 * a year is unreliable. A decision unreferenced for a year has usually been overtaken by unrecorded
 * practice. A preference is the most persistent thing a user tells us, so it gets two years.
 *
 * The floors were high because nothing could refresh a record: they had to protect knowledge that
 * had no other way to stay fresh, which left decay inert (a preference could lose at most 5pp in
 * its whole life). Reinforcement is that other way, so the floors come down and decay does real
 * ranking work again. A floor is what a never-reconfirmed record still counts for at its horizon. */
export const AGING: Record<MemoryKind, { halfLifeDays: number; floor: number; dormantDays: number }> = {
	project_state: { halfLifeDays: 3, floor: 0.5, dormantDays: 7 },
	fact: { halfLifeDays: 60, floor: 0.5, dormantDays: 180 },
	decision: { halfLifeDays: 120, floor: 0.6, dormantDays: 365 },
	preference: { halfLifeDays: 240, floor: 0.7, dormantDays: 730 },
};
export function memoryQuality(memory: DurableMemory, now = Date.now()) {
	const policy = AGING[memory.kind];
	// Decay runs from the last time the record was confirmed, not the last time it was edited.
	// `updatedAt` remains the replacement authority gate and is never moved by confirmation.
	const confirmed = Math.max(Date.parse(memory.updatedAt), Date.parse(memory.reinforcedAt ?? "") || 0);
	const ageDays = Math.max(0, (now - confirmed) / DAY);
	const pinned = memory.layer === "pinned";
	const freshness = pinned ? 1 : policy.floor + (1 - policy.floor) * 2 ** (-ageDays / policy.halfLifeDays);
	const dormant = !pinned && ageDays > policy.dormantDays;
	// Shown to the model as a caution once a record is halfway to dormancy, relative to its own
	// horizon rather than a fixed freshness number, which the floors would make meaningless.
	const aging = !pinned && ageDays > policy.dormantDays / 2;
	const basis = memory.evidence?.basis ?? "unknown";
	const priority = evidencePriority(memory.kind, memory.evidence?.basis);
	const evidenceWeight = 1 + priority * 0.04;
	// Last explicit verdict wins, not frequency. Usefulness never increases evidence priority.
	const utility = memory.feedback?.utility?.verdict === "useful" ? 1.05 : memory.feedback?.utility?.verdict === "unhelpful" ? 0.9 : 1;
	const accuracy = memory.feedback?.accuracy?.verdict === "accurate" ? 1.05 : memory.feedback?.accuracy?.verdict === "incorrect" ? 0.5 : 1;
	return { basis, method: memory.evidence?.method ?? "unknown", ageDays, freshness, dormant, aging,
		confirmedAt: new Date(confirmed).toISOString(),
		evidenceWeight, utility, accuracy, factor: freshness * evidenceWeight * utility * accuracy };
}
