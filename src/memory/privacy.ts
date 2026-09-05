import { createHash } from "node:crypto";

/** Conservative block/line suppression, shared by ingestion, edits and recall. */
export function redact(content: string): string {
	return content
		.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gu, "[REDACTED PRIVATE KEY]")
		.split(/\r?\n/u)
		.map((line) => /(?:["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|credential|authorization|密码|口令|密钥)["']?\s*[:=：]|\bbearer\s+\S|\b(?:gh[opsu]_|github_pat_|sk-)[A-Za-z0-9_-]+|:\/\/[^\s/@]+:[^\s/@]+@)/iu.test(line)
			? "[REDACTED sensitive line]" : line)
		.join("\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
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
