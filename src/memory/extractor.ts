import type { MemoryKind } from "./memory-store.ts";
import { redact, fingerprint } from "./privacy.ts";

export interface Claim {
	kind: MemoryKind;
	content: string;
	/** Existing memory replaced by this claim; absent means addition. */
	replaces?: string;
}

const RULES: [MemoryKind, RegExp][] = [
	["preference", /constraints\s*(?:&|and)\s*preferences|偏好|约束/iu],
	["decision", /key decisions|关键决策|决定/iu],
	["project_state", /progress|blocked|next steps|进展|进行中|阻塞|下一步/iu],
	["fact", /critical context|关键上下文|环境信息/iu],
];

/** No model needed: keep literal code/path characters and task status. */
export function extractStructuredMemories(summary: string): Claim[] {
	const claims: Claim[] = [];
	const seen = new Set<string>();
	let section: { kind: MemoryKind; level: number } | undefined;
	let task = "";
	let fenced = false;
	for (const line of redact(summary).split(/\r?\n/u)) {
		if (/^\s*(?:```|~~~)/u.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
		if (heading) {
			const rule = RULES.find(([, pattern]) => pattern.test(heading[2]));
			if (rule) { section = { kind: rule[0], level: heading[1].length }; task = heading[2]; }
			else if (section && heading[1].length <= section.level) { section = undefined; task = ""; }
			else task = heading[2];
			continue;
		}
		if (!section) continue;
		const bullet = /^\s*(?:[-*]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.+)$/u.exec(line);
		if (!bullet) continue;
		// Only remove wrapping code/bold delimiters, never underscores within identifiers.
		let content = bullet[2].replace(/`([^`]+)`/gu, "$1").replace(/\*\*([^*]+)\*\*/gu, "$1").trim();
		if (section.kind === "project_state") {
			const state = bullet[1]?.toLowerCase() === "x" ? "done" : bullet[1] === " " ? "pending" : task;
			if (state) content = `[${state}] ${content}`;
		}
		if (content.includes("[REDACTED") || content.length < 4 || content.length > 480) continue;
		const key = fingerprint(`${section.kind}:${content}`);
		if (!seen.has(key)) { seen.add(key); claims.push({ kind: section.kind, content }); }
		if (claims.length === 16) break;
	}
	return claims;
}
