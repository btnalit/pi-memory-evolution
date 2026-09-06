import type { DurableMemory } from "./memory-store.ts";
import { clipBytes, fingerprint, redact } from "./privacy.ts";

const CONTINUATION = /继续|之前|上次|恢复|延续|刚才|\b(?:continue|resume|previous)\b|\blast session\b/iu;
const STOP = new Set(["继续", "之前", "上次", "恢复", "延续", "刚才", "the", "and", "for", "with", "continue", "resume", "previous"]);

export function terms(text: string): Set<string> {
	const normalized = text.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
	const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9_-]+/gu) ?? []);
	for (const token of [...tokens]) for (const part of token.split(/[_-]/u)) if (part.length > 1) tokens.add(part);
	for (const span of normalized.match(/[\u3400-\u9fff\uf900-\ufaff]+/gu) ?? [])
		for (let i = 1; i < span.length; i++) tokens.add(span.slice(i-1, i+1));
	return new Set([...tokens].filter((term) => !STOP.has(term)));
}
function overlap(text: string, query: Set<string>): number {
	const tokens = terms(text);
	return [...query].reduce((sum, word) => sum + (tokens.has(word) ? word === "配置" ? 0.25 : 1 : 0), 0);
}

/** One candidate set, literal/CJK matching, bounded recency fallback, claim dedup. */
export function selectRelevantMemories(memories: readonly DurableMemory[], prompt: string, limit = 3, now = Date.now()): DurableMemory[] {
	if (limit <= 0) return [];
	const query = terms(prompt);
	const active = memories.filter((m) => !["forgotten", "conflicted"].includes(m.status)
		&& (m.kind !== "project_state" || m.layer === "pinned" || now - Date.parse(m.updatedAt) <= 7 * 86400_000));
	const scored = active.map((memory) => ({ memory, score: overlap(memory.content, query) }));
	let matched = scored.filter((item) => item.score > 0);
	if (!matched.length && CONTINUATION.test(prompt)) matched = scored;
	matched.sort((a,b) => b.score-a.score || Number(b.memory.layer === "pinned")-Number(a.memory.layer === "pinned")
		|| Date.parse(b.memory.updatedAt)-Date.parse(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
	const seen = new Set<string>();
	return matched.filter(({ memory }) => {
		const key = fingerprint(memory.content);
		if (seen.has(key)) return false;
		seen.add(key); return true;
	}).slice(0, limit).map(({ memory }) => memory);
}

/** Use the matching sentence instead of blindly cutting off the beginning. */
export function excerpt(content: string, prompt: string, budget: number): string {
	const clean = redact(content).trim();
	if (Buffer.byteLength(clean) <= budget) return clean;
	if (budget <= 3) return clipBytes(clean, Math.max(0, budget));
	const query = terms(prompt);
	const sentences = clean.split(/(?<=[。！？!?])\s*|(?<=\.)\s+|\n+/u).filter(Boolean);
	sentences.sort((a,b) => overlap(b, query)-overlap(a, query));
	const best = sentences[0] ?? clean;
	if (Buffer.byteLength(best) <= budget - 3) return best + "…";
	let offset = 0;
	for (const match of best.matchAll(/[\p{L}\p{N}_-]+/gu)) {
		const tokenTerms = terms(match[0]);
		const term = [...query].find((word) => tokenTerms.has(word));
		if (term) { offset = match.index + Math.max(0, match[0].toLowerCase().indexOf(term)); break; }
	}
	// Keep a little preceding context, cutting only at code-point boundaries.
	const reversed = [...best.slice(0, offset)].reverse().join("");
	const prefix = [...clipBytes(reversed, Math.floor((budget - 6) / 3))].reverse().join("");
	const start = offset - prefix.length;
	const lead = start > 0 && budget >= 6 ? "…" : "";
	return lead + clipBytes(best.slice(start), budget - Buffer.byteLength(lead) - 3) + "…";
}
