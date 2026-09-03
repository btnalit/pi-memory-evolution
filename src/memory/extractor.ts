import { createHash } from "node:crypto";
import type { DurableMemoryDraft, MemoryKind } from "./memory-store.ts";

const MAX_CANDIDATES = 16;
const MAX_PER_SECTION = 6;
const MAX_CONTENT_CHARS = 360;

interface SectionRule {
	readonly kind: Exclude<MemoryKind, "compaction_summary">;
	readonly pattern: RegExp;
}

const SECTION_RULES: readonly SectionRule[] = [
	{ kind: "preference", pattern: /(constraints\s*(?:&|and)\s*preferences|偏好|约束)/iu },
	{ kind: "decision", pattern: /(key\s*decisions|关键决策|决定)/iu },
	{ kind: "project_state", pattern: /(progress|in progress|blocked|进展|进行中|阻塞|下一步)/iu },
	{ kind: "fact", pattern: /(critical\s*context|关键上下文|环境信息)/iu },
];

const SENSITIVE_PATTERN = /(密码|口令|密钥|token|secret|password|credential|api[_ -]?key)/iu;

/**
 * Extracts bounded, provisional memory candidates from a Pi compaction summary.
 * This is intentionally structural rather than generative: headings provide the
 * semantic lane, bullets provide the claim, and no model or network is needed.
 */
export function extractStructuredMemories(
	summary: string,
	sourceEntryId: string,
	createdAt: string,
): DurableMemoryDraft[] {
	if (!summary.trim() || !sourceEntryId.trim() || Number.isNaN(Date.parse(createdAt))) {
		return [];
	}

	const candidates: DurableMemoryDraft[] = [];
	const seen = new Set<string>();
	let currentKind: Exclude<MemoryKind, "compaction_summary"> | undefined;
	let currentHeadingLevel = 0;
	const sectionCounts = new Map<Exclude<MemoryKind, "compaction_summary">, number>();

	for (const line of summary.split(/\r?\n/u)) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
		if (heading) {
			const level = heading[1].length;
			const matched = SECTION_RULES.find((rule) => rule.pattern.test(heading[2]));
			if (matched) {
				currentKind = matched.kind;
				currentHeadingLevel = level;
			} else if (level <= currentHeadingLevel) {
				currentKind = undefined;
				currentHeadingLevel = 0;
			}
			continue;
		}
		if (!currentKind) continue;
		const bullet = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/u.exec(line);
		if (!bullet || SENSITIVE_PATTERN.test(bullet[1])) continue;
		if ((sectionCounts.get(currentKind) ?? 0) >= MAX_PER_SECTION) continue;
		const content = normalizeCandidateContent(bullet[1]);
		if (content.length < 8 || content.length > MAX_CONTENT_CHARS) continue;
		const fingerprint = `${currentKind}:${content.toLocaleLowerCase()}`;
		if (seen.has(fingerprint)) continue;
		seen.add(fingerprint);
		sectionCounts.set(currentKind, (sectionCounts.get(currentKind) ?? 0) + 1);
		candidates.push({
			id: `derived:${sourceEntryId}:${currentKind}:${shortHash(content)}`,
			kind: currentKind,
			createdAt,
			sourceEntryId,
			content,
			layer: "durable",
			status: "provisional",
			tags: ["extracted", currentKind],
		});
		if (candidates.length >= MAX_CANDIDATES) break;
	}
	return candidates;
}

function normalizeCandidateContent(value: string): string {
	return value
		.replace(/[`*_~]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
