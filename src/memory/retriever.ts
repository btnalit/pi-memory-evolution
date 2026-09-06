import type { DurableMemory } from "./memory-store.ts";
import { clipBytes, fingerprint, redact } from "./privacy.ts";

// Stop words affect retrieval only: the stored text (including negation) is unchanged.
const STOP = new Set(`继续 之前 上次 恢复 延续 刚才 没有 有没 现在 目前 当前 这个 那个 这些 那些 什么 哪些 怎么 如何 是否 可以 需要 问题 看看 看下 一下 我们 你们 然后 但是 以及 关于 帮我 谢谢 项目 讨论
 the and for with continue resume previous this that these those it its they them their we our you your i me my a an of to in on at is are was were be been do does did has have had no not without now current currently what which who how why can could should would please help check look see any there here also just again about other anything something else one problem problems issue issues wrong broken use used using work home project projects src tmp user users`.split(/\s+/u));
const WEAK = new Set(["配置", "设置", "config", "configuration", "settings"]);
const RESET = /换个话题|新话题|从头开始|不是那个|不是这个|\b(?:new topic|start over|forget that|not that|not this)\b/iu;
const FILLER = /换个话题|新话题|从头开始|不是那个|不是这个|不对|不行|有错|错误|好的|好吧|继续|接着|接上|上次|之前|刚才|以后|现在|目前|没错|没问题|有没有|会不会|是不是|能不能|需不需要|没有|什么|哪些|怎么|如何|是否|可以|需要|应该|问题|看看|看下|一下|这个|那个|这里|那里|这些|那些|还有|其他|修复|修改|检查|处理|做完|开干|开始|讨论|聊聊|帮我|谢谢|[我你它的了呢吗吧啊呀么那这]|\b(?:continue|resume|previous|new topic|start over|forget that|fix|change|check|do|done|start|go|ahead|proceed|please)\b/giu;

export function terms(text: string): Set<string> {
	const normalized = text.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
	const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9_-]+/gu) ?? []);
	for (const token of [...tokens]) for (const part of token.split(/[_-]/u)) if (part.length > 1) tokens.add(part);
	for (const span of normalized.match(/[\u3400-\u9fff\uf900-\ufaff]+/gu) ?? [])
		for (let i = 1; i < span.length; i++) tokens.add(span.slice(i-1, i+1));
	return new Set([...tokens].filter((term) => !STOP.has(term)));
}
function topic(text: string): Set<string> { return terms(text.replace(FILLER, " ")); }

/** A vague follow-up uses the nearest user topic, never an arbitrary recent memory.
 * Explicit new topics stand on their own; only short related follow-ups inherit context.
 * Inputs are oldest first, from the current active branch, not assistant/tool/digest text. */
export function recallQuery(prompt: string, recentUserMessages: readonly string[] = []): string {
	const current = clipBytes(redact(prompt), 2048).trim();
	const currentTopic = topic(current);
	if (RESET.test(current)) return currentTopic.size ? current : "";
	const followup = /继续|接着|这个|那个|它|呢[？?。.!]*$|\b(?:this|that|it|continue|resume)\b/iu.test(current);
	if (currentTopic.size && !followup) return current;
	for (const previous of recentUserMessages.slice(-6).reverse()) {
		const clean = clipBytes(redact(previous), 2048).trim();
		if (clean === current) continue;
		const previousTopic = topic(clean);
		if (previousTopic.size) {
			if (!currentTopic.size) return clean;
			// Do not pull an old topic into a new, explicitly named subject.
			if ([...currentTopic].every((word) => previousTopic.has(word))) return `${current}\n${clean}`;
			break;
		}
		if (RESET.test(clean)) break;
	}
	return currentTopic.size ? current : "";
}

function scoreTerms(tokens: Set<string>, query: Set<string>): number {
	let score = 0;
	for (const word of query) if (tokens.has(word)) score += WEAK.has(word) ? 0.25 : 1;
	return score;
}
function overlap(text: string, query: Set<string>): number { return scoreTerms(terms(text), query); }

/** Global candidate set. Origin is a relevance hint, never an eligibility gate.
 * A weak word, pin or recent timestamp alone cannot make a memory relevant. */
export function selectRelevantMemories(memories: readonly DurableMemory[], prompt: string, limit = 3, now = Date.now(), preferredOrigin?: string): DurableMemory[] {
	if (limit <= 0) return [];
	const query = terms(prompt);
	const strong = new Set([...query].filter((word) => !WEAK.has(word)));
	if (!strong.size) return [];
	const active = memories.filter((m) => !["forgotten", "conflicted"].includes(m.status)
		&& (m.kind !== "project_state" || m.layer === "pinned" || now - Date.parse(m.updatedAt) <= 7 * 86400_000));
	const matched = active.map((memory) => {
		const originName = memory.scope === "legacy" ? "" : memory.scope.split(/[\\/]/u).at(-1) ?? "";
		const contentTerms = terms(memory.content), originTerms = terms(originName);
		return { memory, eligible: scoreTerms(contentTerms, strong) > 0 || scoreTerms(originTerms, strong) > 0,
			score: scoreTerms(contentTerms, query) + 0.5 * scoreTerms(originTerms, query) };
	}).filter((item) => item.eligible);
	matched.sort((a,b) => b.score-a.score || Number(b.memory.scope === preferredOrigin)-Number(a.memory.scope === preferredOrigin)
		|| Number(b.memory.layer === "pinned")-Number(a.memory.layer === "pinned")
		|| Date.parse(b.memory.updatedAt)-Date.parse(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
	const seen = new Set<string>();
	return matched.filter(({ memory }) => {
		// Identical port/path claims in different contexts are not the same fact.
		const key = fingerprint(JSON.stringify([memory.scope, memory.content]));
		if (seen.has(key)) return false;
		seen.add(key); return true;
	}).slice(0, limit).map(({ memory }) => memory);
}

/** Use the matching sentence instead of blindly cutting off the beginning. */
export function excerpt(content: string, prompt: string, budget = 400): string {
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
