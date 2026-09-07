import type { DurableMemory } from "./memory-store.ts";
import { clipBytes, fingerprint, redact } from "./privacy.ts";
import { features, featureOffset } from "./search.ts";

const WEAK = new Set(["配置", "设置", "config", "configuration", "settings"]);
const RESET = /换个话题|新话题|从头开始|不是那个|不是这个|\b(?:new topic|start over|forget that|not that|not this)\b/iu;
const FILLER = /换个话题|新话题|从头开始|不是那个|不是这个|不对|不行|有错|错误|好的|好吧|继续|接着|接上|未完成|未完|没完成|上次|之前|刚才|以后|现在|目前|没错|没问题|有没有|会不会|是不是|能不能|需不需要|没有|什么|哪些|怎么|如何|是否|可以|需要|应该|问题|看看|看下|一下|这个|那个|这里|那里|这些|那些|还有|其他|修复|修改|检查|处理|做完|开干|开始|讨论|聊聊|帮我|谢谢|[我你它的了呢吗吧啊呀么那这]|\b(?:continue|resume|previous|new topic|start over|forget that|fix|change|check|do|done|start|go|ahead|proceed|please)\b/giu;

function topic(text: string): Set<string> {
	return new Set([...features(text.replace(FILLER, " "))].filter((word) => !WEAK.has(word)));
}

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

function overlap(text: string, query: Set<string>): number {
	const tokens = features(text);
	return [...query].filter((word) => tokens.has(word)).length;
}

/** Relevance scores are NOT confidence/truth scores. No authority bonus for cwd,
 * legacy labels, source IDs or dates. Metadata can only help an explicit origin query. */
type RecallOptions = { includeExpiredProjectState?: boolean };
export function rankMemories(memories: readonly DurableMemory[], prompt: string, now = Date.now(), options: RecallOptions = {}) {
	const query = features(prompt);
	for (const word of query) {
		if (WEAK.has(word)) query.delete(word);
		if (word.startsWith("literal:") && word.includes("/")) query.delete(`literal:${word.split("/").at(-1)}`);
	}
	if (!query.size) return [];
	const active = memories.filter((m) => !["forgotten", "conflicted"].includes(m.status)
		&& (options.includeExpiredProjectState || m.kind !== "project_state" || m.layer === "pinned" || now - Date.parse(m.updatedAt) <= 7 * 86400_000));
	// Repeated origins/aliases (and duplicate legacy text) need segmentation only once
	// per query. No persistent cache of user queries or credential-bearing input.
	const cache = new Map<string, Set<string>>();
	const tokenize = (text: string) => {
		let result = cache.get(text);
		if (!result) { result = features(text); cache.set(text, result); }
		return result;
	};
	const documents = active.map((memory) => ({ memory, body: tokenize(memory.content),
		aliases: tokenize((memory.searchTerms ?? []).join(" ")),
		origin: new Set(memory.scope === "legacy" ? [] : [...tokenize(memory.scope),
			...tokenize(memory.scope.split(/[\\/]/u).at(-1) ?? "")].filter((word) => !word.startsWith("concept:"))) }));
	const weights = new Map([...query].map((word) => {
		const df = documents.filter((d) => d.body.has(word) || d.aliases.has(word) || d.origin.has(word)).length;
		return [word, (word.startsWith("literal:") ? 2 : 1) * (1 + Math.log((documents.length + 1) / (df + 1)))];
	}));
	const total = [...weights.values()].reduce((a,b) => a+b, 0);
	const ranked = documents.map(({ memory, body, aliases, origin }) => {
		let score = 0, covered = 0;
		const matches: string[] = [];
		for (const [word, weight] of weights) {
			const factor = body.has(word) ? 1 : aliases.has(word) ? 0.8 : origin.has(word) ? 0.2 : 0;
			if (factor) { score += weight * factor; covered += weight; matches.push(word); }
		}
		return { memory, score, coverage: covered / total, matches };
	}).filter((r) => r.score > 0 && r.coverage >= 0.45 && (query.size < 3 || r.matches.length >= 2));
	ranked.sort((a,b) => b.score-a.score || Number(b.memory.layer === "pinned")-Number(a.memory.layer === "pinned")
		|| Date.parse(b.memory.updatedAt)-Date.parse(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
	const best = ranked[0]?.score ?? Infinity;
	return ranked.filter((r) => r.score >= best * 0.75);
}

export function selectRelevantMemories(memories: readonly DurableMemory[], prompt: string, limit = 3, now = Date.now(), options: RecallOptions = {}): DurableMemory[] {
	if (limit <= 0) return [];
	const selected: DurableMemory[] = [];
	const seen = new Set<string>();
	const covered = new Map<string, Set<string>>();
	const ranked = rankMemories(memories, prompt, now, options);
	for (const { memory, matches } of ranked) {
		const key = fingerprint(JSON.stringify([memory.scope, memory.content]));
		if (seen.has(key)) continue;
		// For specific multi-feature questions, don't spend another slot repeating the
		// same matched facets from the same origin. Different origins remain distinct.
		const previous = covered.get(memory.scope) ?? new Set<string>();
		if (matches.length >= 2 && ranked[0].matches.length >= 3 && matches.every((term) => previous.has(term))) continue;
		seen.add(key); matches.forEach((term) => previous.add(term)); covered.set(memory.scope, previous);
		selected.push(memory);
		if (selected.length >= limit) break;
	}
	return selected;
}

/** Use the matching sentence instead of blindly cutting off the beginning. */
export function excerpt(content: string, prompt: string, budget = 400): string {
	const clean = redact(content).trim();
	if (Buffer.byteLength(clean) <= budget) return clean;
	if (budget <= 3) return clipBytes(clean, Math.max(0, budget));
	const query = features(prompt);
	const sentences = clean.split(/(?<=[。！？!?])\s*|(?<=\.)\s+|\n+/u).filter(Boolean);
	sentences.sort((a,b) => overlap(b, query)-overlap(a, query));
	const best = sentences[0] ?? clean;
	if (Buffer.byteLength(best) <= budget - 3) return best + "…";
	const positions = [...query].map((word) => featureOffset(best, word)).filter((index) => index >= 0);
	const offset = positions.length ? Math.min(...positions) : 0;
	// Keep a little preceding context, cutting only at code-point boundaries.
	const reversed = [...best.slice(0, offset)].reverse().join("");
	const prefix = [...clipBytes(reversed, Math.floor((budget - 6) / 3))].reverse().join("");
	const start = offset - prefix.length;
	const lead = start > 0 && budget >= 6 ? "…" : "";
	return lead + clipBytes(best.slice(start), budget - Buffer.byteLength(lead) - 3) + "…";
}
