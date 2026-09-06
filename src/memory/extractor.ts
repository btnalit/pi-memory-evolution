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
export function extractStructuredMemories(summary: string, limit = 16): Claim[] {
	const claims: Claim[] = [];
	if (limit <= 0) return claims;
	const seen = new Set<string>();
	const sections: { kind?: MemoryKind; level: number; task: string }[] = [];
	let fence: string | undefined;
	for (const line of redact(summary).split(/\r?\n/u)) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
			continue;
		}
		if (marker) { fence = marker[1]; continue; }
		const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
		if (heading) {
			const level = heading[1].length;
			while (sections.length && sections.at(-1)!.level >= level) sections.pop();
			const rule = RULES.find(([, pattern]) => pattern.test(heading[2]));
			sections.push({ level, kind: rule?.[0] ?? sections.at(-1)?.kind, task: heading[2] });
			continue;
		}
		const section = sections.at(-1);
		if (!section?.kind) continue;
		const bullet = /^ {0,3}(?:[-*]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.+)$/u.exec(line);
		if (!bullet) continue;
		// Protect code before stripping simple bold labels; globs are not emphasis.
		const code: string[] = [];
		let content = bullet[2].replace(/(?<!`)(`+)(?!`)(.+?)\1(?!`)/gu, (_match, _ticks, body: string) => {
			code.push(/^ .* $/u.test(body) && /\S/u.test(body) ? body.slice(1, -1) : body);
			return `\u0000${code.length - 1}\u0000`;
		}).replace(/\*\*([\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*)\*\*/gu, "$1")
			.replace(/\u0000(\d+)\u0000/gu, (_match, index: string) => code[Number(index)]).trim();
		if (section.kind === "project_state") {
			const state = bullet[1]?.toLowerCase() === "x" ? "done" : bullet[1] === " " ? "pending" : section.task;
			if (state) content = `[${state}] ${content}`;
		}
		if (content.includes("[REDACTED") || content.length < 4 || content.length > 480) continue;
		const key = fingerprint(`${section.kind}:${content}`);
		if (!seen.has(key)) { seen.add(key); claims.push({ kind: section.kind, content }); }
		if (claims.length >= limit) break;
	}
	return claims;
}
