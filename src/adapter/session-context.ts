import type { ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { clipBytes, redact } from "../memory/privacy.ts";
import { resolveRecallQuery } from "../memory/query.ts";

/** Read only the active branch; never index full session files or use injected/assistant
 * messages as a topic. Pi's context entries honor /tree, /resume and compaction tails. */
export function recentUserMessages(ctx: ExtensionContext): string[] {
	try {
		const manager = ctx.sessionManager;
		if (typeof manager.buildContextEntries !== "function") return [];
		const entries = manager.buildContextEntries();
		const result: string[] = [];
		let scanned = 0;
		for (const entry of entries.slice(-4096).reverse()) {
			// Standalone Pi supports retainedTail before some npm SDK declarations do.
			const tail = (entry as { retainedTail?: SessionMessageEntry["message"][] }).retainedTail;
			const messages = entry.type === "message" ? [entry.message]
				: entry.type === "compaction" && Array.isArray(tail) ? tail : [];
			for (const message of messages.slice(-4096).reverse()) {
				if (++scanned > 4096) return result.reverse();
				if (message.role !== "user") continue;
				const content = typeof message.content === "string" ? message.content
					: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				const clean = clipBytes(redact(content), 2048).trim();
				if (clean && !/^\/\w/u.test(clean)) {
					// Repeated topic-less continuations must not consume every subject slot.
					// Reset/unknown-topic messages are retained as hard inheritance barriers.
					const empty = resolveRecallQuery(clean).mode === 'empty';
					if (!(empty && result.length && resolveRecallQuery(result.at(-1)!).mode === 'empty')) result.push(clean);
				}
				if (result.length >= 6) return result.reverse();
			}
		}
		return result.reverse();
	} catch { return []; } // A missing/invalidated context must not disable direct-query recall.
}
