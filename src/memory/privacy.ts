import { createHash } from "node:crypto";

const KEY = String.raw`["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|credentials?|authorization|密码|口令|密钥)["']?\s*[:=：]`;
const ASSIGNMENT = new RegExp(KEY, "iu");
const QUOTED_VALUE = new RegExp(`${KEY}\\s*(?:"(?:\\\\[\\s\\S]|[^"\\\\])*(?:"|$)|'(?:\\\\[\\s\\S]|[^'\\\\])*(?:'|$))`, "giu");
const SECRET = /\bbearer\s+\S|\b(?:gh[opsu]_|github_pat_|sk-)[A-Za-z0-9_-]+|:\/\/[^\s/@]+:[^\s/@]+@|--(?:password|token|api-key|secret)\s+\S/iu;

/** Conservative block/line suppression, shared by ingestion, edits and recall. */
export function redact(content: string): string {
	// Normalize first: removing a control must not assemble an unchecked password label.
	const clean = content.replace(/\r\n?/gu, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
		.replace(/-----BEGIN [^-\n]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY(?: BLOCK)?-----|$)/gu, "[REDACTED PRIVATE KEY]")
		.replace(QUOTED_VALUE, "[REDACTED sensitive value]");
	const lines: string[] = [];
	let hidden: { indent: number; first: boolean } | undefined;
	for (const line of clean.split("\n")) {
		const indent = line.match(/^\s*/u)![0].length;
		if (hidden) {
			if (!line.trim()) continue;
			if (hidden.first || indent > hidden.indent) { hidden.first = false; continue; }
			hidden = undefined;
		}
		const assignment = ASSIGNMENT.exec(line);
		if (assignment || SECRET.test(line)) {
			lines.push("[REDACTED sensitive line]");
			if (assignment) {
				const tail = line.slice(assignment.index + assignment[0].length).trim();
				hidden = { indent, first: !tail };
			}
		} else lines.push(line);
	}
	return lines.join("\n");
}

export function fingerprint(content: string): string {
	// Case and inner whitespace can be significant in paths, identifiers and literals.
	return createHash("sha256").update(content.trim()).digest("hex").slice(0, 24);
}

/** UTF-8 budget, never split a code point. */
export function clipBytes(text: string, budget: number): string {
	let bytes = 0;
	let result = "";
	for (const char of text) {
		bytes += Buffer.byteLength(char);
		if (bytes > budget) break;
		result += char;
	}
	return result;
}
