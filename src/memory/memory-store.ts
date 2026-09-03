import {
	appendFileSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";

/** Schema version for durable memory records. */
export const MEMORY_VERSION = 1;

/** A durable memory currently produced from a successful compaction. */
export interface DurableMemory {
	readonly version: typeof MEMORY_VERSION;
	readonly id: string;
	readonly kind: "compaction_summary";
	readonly createdAt: string;
	readonly sourceEntryId: string;
	readonly content: string;
}

/** Input used when appending a durable memory. */
export type DurableMemoryDraft = Omit<DurableMemory, "version">;

/** Persistent store for cross-session memories. */
export interface MemoryStore {
	readonly stateDir: string;
	readMemories(): DurableMemory[];
	appendMemory(memory: DurableMemoryDraft): void;
}

const MEMORIES_FILE = "memories.jsonl";

/** Creates a durable memory store backed by the extension state directory. */
export function createMemoryStore(stateDir: string): MemoryStore {
	ensureStateDir(stateDir);
	return {
		stateDir,
		readMemories: () => readMemories(stateDir),
		appendMemory: (memory) => appendMemory(stateDir, memory),
	};
}

/** Reads valid durable memories, ignoring malformed or incompatible lines. */
function readMemories(stateDir: string): DurableMemory[] {
	const file = join(stateDir, MEMORIES_FILE);
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return [];
	}

	const memories: DurableMemory[] = [];
	for (const line of content.split("\n")) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (isDurableMemory(parsed)) {
				memories.push(parsed);
			}
		} catch {
			// One damaged line must not make all durable memories unavailable.
		}
	}
	return memories;
}

/** Appends one memory unless its source entry was already persisted. */
function appendMemory(
	stateDir: string,
	memory: DurableMemoryDraft,
): void {
	ensureStateDir(stateDir);
	const existing = readMemories(stateDir);
	if (existing.some((item) => item.id === memory.id)) {
		return;
	}
	const record: DurableMemory = {
		version: MEMORY_VERSION,
		...memory,
		content: redactSensitiveContent(memory.content),
	};
	appendFileSync(join(stateDir, MEMORIES_FILE), `${JSON.stringify(record)}\n`);
}

/** Checks the persisted record shape before exposing it to the injector. */
function isDurableMemory(value: unknown): value is DurableMemory {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.version === MEMORY_VERSION &&
		typeof record.id === "string" &&
		record.kind === "compaction_summary" &&
		typeof record.createdAt === "string" &&
		!Number.isNaN(Date.parse(record.createdAt)) &&
		typeof record.sourceEntryId === "string" &&
		typeof record.content === "string" &&
		record.content.trim().length > 0
	);
}

/** Redacts common credential formats before a summary leaves the session store. */
function redactSensitiveContent(content: string): string {
	return content
		.replace(
			/(\b(?:api[_ -]?key|access[_ -]?token|password|passwd|secret)\s*[:=]\s*)[^\s,;]+/gi,
			"$1[REDACTED]",
		)
		.replace(/\bgh[opsu]_[A-Za-z0-9_]+\b/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]");
}

/** Creates the state directory when it does not yet exist. */
function ensureStateDir(stateDir: string): void {
	mkdirSync(stateDir, { recursive: true });
}
