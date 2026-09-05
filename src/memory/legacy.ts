import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DurableMemory, MemoryKind } from "./memory-store.ts";
import { extractStructuredMemories } from "./extractor.ts";
import { fingerprint, redact } from "./privacy.ts";

/** One-time, read-only import. Unknown project scope is quarantined, never guessed. */
export function loadLegacyMemories(dir: string): DurableMemory[] {
	const records = new Map<string, Record<string, any>>();
	for (const record of lines(join(dir, "memories.jsonl"))) {
		if (record.version !== 1 || typeof record.id !== "string" || typeof record.content !== "string"
			|| typeof record.sourceEntryId !== "string" || !Number.isFinite(Date.parse(record.createdAt))
			|| !["compaction_summary", "fact", "preference", "decision", "project_state"].includes(record.kind)) throw new Error("Invalid legacy memory; import stopped");
		if (!records.has(record.id)) records.set(record.id, { ...record, status: record.status ?? "provisional" });
	}
	const mutedSources = new Set<string>();
	for (const action of lines(join(dir, "memory-actions.jsonl"))) {
		if (action.version !== 1 || typeof action.memoryId !== "string" || !Number.isFinite(Date.parse(action.createdAt))
			|| !["confirm", "correct", "forget", "pin", "unpin", "conflict", "resolve"].includes(action.type)) throw new Error("Invalid legacy action; import stopped");
		const target = records.get(action.memoryId);
		if (!target) throw new Error("Legacy action target missing; import stopped");
		target.updatedAt = action.createdAt;
		if (action.type === "correct") {
			if (typeof action.content !== "string" || !action.content.trim()) throw new Error("Invalid legacy correction");
			target.content = action.content; target.status = "confirmed";
		} else if (action.type === "forget") target.status = "forgotten";
		else if (action.type === "confirm" || action.type === "resolve") target.status = "confirmed";
		else if (action.type === "pin") target.layer = "pinned";
		else if (action.type === "unpin") target.layer = "durable";
		else if (action.type === "conflict") {
			const other = records.get(action.conflictWith);
			if (!other) throw new Error("Legacy conflict target missing");
			target.status = other.status = "conflicted";
			mutedSources.add(other.sourceEntryId);
			for (const sibling of records.values()) if (sibling.sourceEntryId === other.sourceEntryId) sibling.status = "conflicted";
		}
		if (["correct", "forget", "conflict"].includes(action.type)) {
			if (target.kind === "compaction_summary") {
				for (const sibling of records.values()) if (sibling.id !== target.id && sibling.sourceEntryId === target.sourceEntryId)
					sibling.status = action.type === "conflict" ? "conflicted" : "forgotten";
			} else mutedSources.add(target.sourceEntryId);
		}
	}
	const memories: DurableMemory[] = [];
	const childContent = new Set([...records.values()].filter((r) => r.kind !== "compaction_summary").map((r) => fingerprint(r.content)));
	for (const record of records.values()) {
		if (record.kind === "compaction_summary") {
			if (mutedSources.has(record.sourceEntryId) || ["forgotten", "conflicted"].includes(record.status)) continue;
			for (const claim of extractStructuredMemories(record.content)) {
				// Preserve child tombstones rather than re-extracting a forgotten fact.
				if (childContent.has(fingerprint(claim.content))) continue;
				memories.push(convert({ ...record, ...claim, id: `legacy:${fingerprint(record.id + claim.content)}` }));
			}
		} else memories.push(convert(record));
	}
	return memories;
}

function convert(record: Record<string, any>): DurableMemory {
	return { id: record.id, kind: record.kind as MemoryKind, content: redact(record.content), scope: "legacy",
		sourceEntryId: record.sourceEntryId, createdAt: new Date(record.createdAt).toISOString(),
		updatedAt: new Date(record.updatedAt ?? record.createdAt).toISOString(), revision: 1,
		layer: record.layer === "pinned" ? "pinned" : "durable", status: record.status };
}
function lines(path: string): Record<string, any>[] {
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("Legacy ledger unreadable; import stopped"); }
	return text.split("\n").filter((line) => line.trim()).map((line) => {
		let value: unknown;
		try { value = JSON.parse(line); } catch { throw new Error("Damaged legacy ledger; import stopped (original preserved)"); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy ledger row");
		return value as Record<string, any>;
	});
}
