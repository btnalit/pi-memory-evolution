import type { DurableMemory } from "./memory-store.ts";

/** Maximum number of durable memories selected for one prompt. */
export const DEFAULT_MEMORY_LIMIT = 3;

/** Maximum characters reserved for selected memory content. */
export const DEFAULT_MEMORY_CHAR_BUDGET = 1100;

/** Selects durable memories relevant to a prompt, newest first on ties. */
export function selectRelevantMemories(
	memories: readonly DurableMemory[],
	prompt: string,
	limit = DEFAULT_MEMORY_LIMIT,
	charBudget = DEFAULT_MEMORY_CHAR_BUDGET,
): DurableMemory[] {
	if (limit <= 0 || charBudget <= 0 || memories.length === 0) {
		return [];
	}

	const queryTerms = terms(prompt);
	const wantsRecentContext = CONTINUATION_PATTERN.test(prompt);
	const scored = memories.map((memory, index) => ({
		memory,
		index,
		score: relevanceScore(memory, queryTerms),
	}));
	const matching = scored.filter((item) => item.score > 0);
	const ranked = (matching.length > 0
		? matching
		: wantsRecentContext
			? scored
			: [])
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			if (right.memory.createdAt !== left.memory.createdAt) {
				return right.memory.createdAt.localeCompare(left.memory.createdAt);
			}
			return right.index - left.index;
		})
		.slice(0, limit);

	const selected: DurableMemory[] = [];
	let used = 0;
	for (const item of ranked) {
		const remaining = charBudget - used;
		if (remaining <= 0) {
			break;
		}
		const content = item.memory.content.slice(0, remaining);
		if (content.trim().length === 0) {
			continue;
		}
		selected.push(
			content.length === item.memory.content
				? item.memory
				: { ...item.memory, content },
		);
		used += content.length;
	}
	return selected;
}

/** Scores shared meaningful terms, with a small recency-independent floor avoided. */
function relevanceScore(
	memory: DurableMemory,
	queryTerms: ReadonlySet<string>,
): number {
	if (queryTerms.size === 0) {
		return 0;
	}
	const memoryTerms = terms(memory.content);
	let overlap = 0;
	for (const term of queryTerms) {
		if (memoryTerms.has(term)) {
			overlap++;
		}
	}
	return overlap;
}

/** Extracts Latin words and CJK bigrams for language-tolerant matching. */
function terms(text: string): Set<string> {
	const normalized = text.toLocaleLowerCase();
	const result = new Set(
		normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [],
	);
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
