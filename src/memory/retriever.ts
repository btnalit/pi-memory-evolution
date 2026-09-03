import type { DurableMemory, MemoryLayer } from "./memory-store.ts";

/** Maximum number of durable memories selected for one prompt. */
export const DEFAULT_MEMORY_LIMIT = 3;

/** Maximum characters reserved for selected memory content. */
export const DEFAULT_MEMORY_CHAR_BUDGET = 1100;

const RRF_K = 60;
const LAYER_WEIGHT: Record<MemoryLayer, number> = {
	pinned: 3,
	durable: 2,
	recent: 1,
};

/**
 * Select memories with a small local hybrid ranker.
 *
 * The lanes intentionally stay deterministic and offline:
 *   1. lexical overlap (Latin words + CJK bigrams),
 *   2. layer authority (pinned > durable > recent),
 *   3. recency fallback for explicit continuation prompts.
 *
 * Reciprocal Rank Fusion combines the lanes without pretending that a raw
 * lexical score is comparable to a recency or authority score.
 */
export function selectRelevantMemories(
	memories: readonly DurableMemory[],
	prompt: string,
	limit = DEFAULT_MEMORY_LIMIT,
	charBudget = DEFAULT_MEMORY_CHAR_BUDGET,
): DurableMemory[] {
	if (limit <= 0 || charBudget <= 0 || memories.length === 0) return [];

	const now = Date.now();
	const active = memories.filter((memory) => isRecallable(memory, now));
	if (active.length === 0) return [];

	const queryTerms = terms(prompt);
	const continuation = CONTINUATION_PATTERN.test(prompt);
	const lexical = active
		.map((memory, index) => ({
			memory,
			index,
			score: overlapScore(memory, queryTerms),
		}))
		.filter((item) => item.score > 0)
		.sort((left, right) => compareLexical(left, right));

	const candidates = lexical.length > 0
		? lexical
		: continuation
			? active.map((memory, index) => ({ memory, index, score: 0 }))
				.sort((left, right) => compareRecent(left, right))
			: [];
	if (candidates.length === 0) return [];

	const layerLane = [...candidates].sort((left, right) => {
		const layerDelta = layerWeight(right.memory) - layerWeight(left.memory);
		return layerDelta || compareLexical(left, right);
	});
	const recentLane = [...candidates].sort((left, right) => compareRecent(left, right));
	const lanes = lexical.length > 0
		? [lexical, layerLane, recentLane]
		: [recentLane];

	const fused = new Map<string, { item: (typeof candidates)[number]; score: number }>();
	for (const lane of lanes) {
		lane.forEach((item, rank) => {
			const existing = fused.get(item.memory.id);
			const score = 1 / (RRF_K + rank + 1);
			fused.set(item.memory.id, {
				item,
				score: (existing?.score ?? 0) + score,
			});
		});
	}

	const ranked = [...fused.values()]
		.sort((left, right) => {
			const fusedDelta = right.score - left.score;
			if (fusedDelta !== 0) return fusedDelta;
			return compareLexical(left.item, right.item);
		})
		.slice(0, limit);

	const selected: DurableMemory[] = [];
	let used = 0;
	for (const entry of ranked) {
		const remaining = charBudget - used;
		if (remaining <= 0) break;
		const content = entry.item.memory.content.slice(0, remaining);
		if (!content.trim()) continue;
		selected.push(
			content.length === entry.item.memory.content
				? entry.item.memory
				: { ...entry.item.memory, content },
		);
		used += content.length;
	}
	return selected;
}

function isRecallable(memory: DurableMemory, now: number): boolean {
	if (memory.status === "forgotten" || memory.status === "conflicted") return false;
	if (!memory.expiresAt) return true;
	const expiresAt = Date.parse(memory.expiresAt);
	return !Number.isNaN(expiresAt) && expiresAt > now;
}

function overlapScore(memory: DurableMemory, queryTerms: ReadonlySet<string>): number {
	if (queryTerms.size === 0) return 0;
	const memoryTerms = terms(
		`${memory.content} ${(memory.tags ?? []).join(" ")} ${memory.kind}`,
	);
	let overlap = 0;
	for (const term of queryTerms) {
		if (memoryTerms.has(term)) overlap++;
	}
	return overlap;
}

function compareLexical(
	left: { memory: DurableMemory; index: number; score: number },
	right: { memory: DurableMemory; index: number; score: number },
): number {
	const scoreDelta = right.score - left.score;
	if (scoreDelta !== 0) return scoreDelta;
	const layerDelta = layerWeight(right.memory) - layerWeight(left.memory);
	if (layerDelta !== 0) return layerDelta;
	return compareRecent(left, right);
}

function compareRecent(
	left: { memory: DurableMemory; index: number },
	right: { memory: DurableMemory; index: number },
): number {
	const leftDate = left.memory.updatedAt ?? left.memory.createdAt;
	const rightDate = right.memory.updatedAt ?? right.memory.createdAt;
	if (rightDate !== leftDate) return rightDate.localeCompare(leftDate);
	return right.index - left.index;
}

function layerWeight(memory: DurableMemory): number {
	return LAYER_WEIGHT[memory.layer ?? "durable"];
}

/** Extracts Latin words and CJK bigrams for language-tolerant matching. */
function terms(text: string): Set<string> {
	const normalized = text.toLocaleLowerCase();
	const result = new Set(normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []);
	const cjk = Array.from(normalized).filter((char) =>
		/[\u3400-\u9fff\uf900-\ufaff]/u.test(char),
	);
	for (let index = 0; index + 1 < cjk.length; index++) {
		result.add(`${cjk[index]}${cjk[index + 1]}`);
	}
	return result;
}

const CONTINUATION_PATTERN =
	/(继续|之前|上次|上一个会话|恢复|延续|刚才|previous|continue|resume|last session)/iu;
