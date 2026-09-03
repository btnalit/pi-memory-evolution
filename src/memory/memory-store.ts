import {
	appendFileSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Schema version for durable memory records. */
export const MEMORY_VERSION = 1;

export type MemoryKind =
	| "compaction_summary"
	| "fact"
	| "preference"
	| "decision"
	| "project_state";
export type MemoryLayer = "recent" | "durable" | "pinned";
export type MemoryStatus = "provisional" | "confirmed" | "forgotten" | "conflicted";
export type MemoryActionType =
	| "confirm"
	| "correct"
	| "forget"
	| "pin"
	| "unpin"
	| "conflict"
	| "resolve";

/** A local, layered memory record. Optional fields preserve v1 compatibility. */
export interface DurableMemory {
	readonly version: typeof MEMORY_VERSION;
	readonly id: string;
	readonly kind: MemoryKind;
	readonly createdAt: string;
	readonly updatedAt?: string;
	readonly sourceEntryId: string;
	readonly content: string;
	readonly layer?: MemoryLayer;
	readonly status?: MemoryStatus;
	readonly tags?: readonly string[];
	readonly claimKey?: string;
	readonly expiresAt?: string;
	readonly conflictWith?: readonly string[];
}

/** Input used when appending a durable memory. */
export type DurableMemoryDraft = Omit<DurableMemory, "version">;

/** Append-only lifecycle operation applied as a read-time projection. */
export interface MemoryAction {
	readonly version: typeof MEMORY_VERSION;
	readonly id: string;
	readonly createdAt: string;
	readonly memoryId: string;
	readonly type: MemoryActionType;
	readonly content?: string;
	readonly conflictWith?: string;
}

export type MemoryActionDraft = Omit<MemoryAction, "version" | "id" | "createdAt"> & {
	readonly id?: string;
	readonly createdAt?: string;
};

/** Persistent store for cross-session memories and lifecycle actions. */
export interface MemoryStore {
	readonly stateDir: string;
	readMemories(): DurableMemory[];
	appendMemory(memory: DurableMemoryDraft): void;
	appendAction(action: MemoryActionDraft): void;
}

const MEMORIES_FILE = "memories.jsonl";
const ACTIONS_FILE = "memory-actions.jsonl";

/** Creates a local store backed by append-only JSONL files. */
export function createMemoryStore(stateDir: string): MemoryStore {
	ensureStateDir(stateDir);
	return {
		stateDir,
		readMemories: () => readMemories(stateDir),
		appendMemory: (memory) => appendMemory(stateDir, memory),
		appendAction: (action) => appendAction(stateDir, action),
	};
}

/** Reads valid memories and applies lifecycle actions without rewriting history. */
function readMemories(stateDir: string): DurableMemory[] {
	const file = join(stateDir, MEMORIES_FILE);
	const memories = readJsonLines(file).filter(isDurableMemory);
	const projected = new Map<string, DurableMemory>();
	for (const memory of memories) {
		if (!projected.has(memory.id)) {
			projected.set(memory.id, normalizeMemory(memory));
		}
	}

	for (const action of readJsonLines(join(stateDir, ACTIONS_FILE)).filter(isMemoryAction)) {
		const current = projected.get(action.memoryId);
		if (!current) {
			continue;
		}
		applyAction(projected, current, action);
	}
	return [...projected.values()];
}

/** Appends one memory unless its stable id was already persisted. */
function appendMemory(stateDir: string, memory: DurableMemoryDraft): void {
	ensureStateDir(stateDir);
	if (readJsonLines(join(stateDir, MEMORIES_FILE)).some(
		(value) => isDurableMemory(value) && value.id === memory.id,
	)) {
		return;
	}
	const record: DurableMemory = {
		version: MEMORY_VERSION,
		...memory,
		kind: memory.kind ?? "compaction_summary",
		layer: memory.layer ?? "durable",
		status: memory.status ?? "provisional",
		content: redactSensitiveContent(memory.content),
	};
	if (!isDurableMemory(record)) {
		throw new TypeError("Invalid durable memory record");
	}
	appendFileSync(join(stateDir, MEMORIES_FILE), `${JSON.stringify(record)}\n`);
}

/** Appends an explicit owner lifecycle action after validating its target. */
function appendAction(stateDir: string, action: MemoryActionDraft): void {
	ensureStateDir(stateDir);
	const target = readMemories(stateDir).find((memory) => memory.id === action.memoryId);
	if (!target) {
		throw new Error(`Unknown memory id: ${action.memoryId}`);
	}
	if (action.type === "conflict" && !readMemories(stateDir).some(
		(memory) => memory.id === action.conflictWith,
	)) {
		throw new Error(`Unknown conflicting memory id: ${action.conflictWith}`);
	}
	if (!ACTION_TYPES.has(action.type)) {
		throw new TypeError(`Unsupported memory action: ${action.type}`);
	}
	if (action.type === "correct" && !String(action.content ?? "").trim()) {
		throw new TypeError("A correction requires replacement content");
	}
	if (action.type === "conflict" && !String(action.conflictWith ?? "").trim()) {
		throw new TypeError("A conflict action requires another memory id");
	}
	const record: MemoryAction = {
		version: MEMORY_VERSION,
		id: action.id ?? `action:${randomUUID()}`,
		createdAt: action.createdAt ?? new Date().toISOString(),
		memoryId: action.memoryId,
		type: action.type,
		...(action.content === undefined ? {} : { content: redactSensitiveContent(action.content) }),
		...(action.conflictWith === undefined ? {} : { conflictWith: action.conflictWith }),
	};
	if (!isMemoryAction(record)) {
		throw new TypeError("Invalid memory action record");
	}
	appendFileSync(join(stateDir, ACTIONS_FILE), `${JSON.stringify(record)}\n`);
}

function applyAction(
	projected: Map<string, DurableMemory>,
	memory: DurableMemory,
	action: MemoryAction,
): void {
	const updated = (patch: Partial<DurableMemory>): DurableMemory => ({
		...memory,
		...patch,
		updatedAt: action.createdAt,
	});
	switch (action.type) {
		case "confirm":
			projected.set(memory.id, updated({ status: "confirmed", layer: "durable" }));
			break;
		case "correct":
			projected.set(memory.id, updated({
				content: redactSensitiveContent(action.content ?? memory.content),
				status: "confirmed",
				layer: "durable",
				conflictWith: [],
			}));
			break;
		case "forget":
			projected.set(memory.id, updated({ status: "forgotten" }));
			break;
		case "pin":
			projected.set(memory.id, updated({ status: "confirmed", layer: "pinned" }));
			break;
		case "unpin":
			projected.set(memory.id, updated({ layer: "durable" }));
			break;
		case "resolve":
			projected.set(memory.id, updated({
				status: "confirmed",
				layer: "durable",
				conflictWith: [],
			}));
			break;
		case "conflict": {
			const otherId = action.conflictWith ?? "";
			projected.set(memory.id, updated({
				status: "conflicted",
				conflictWith: [...new Set([...(memory.conflictWith ?? []), otherId])],
			}));
			const other = projected.get(otherId);
			if (other) {
				projected.set(otherId, {
					...other,
					status: "conflicted",
					updatedAt: action.createdAt,
					conflictWith: [...new Set([...(other.conflictWith ?? []), memory.id])],
				});
			}
			break;
		}
	}
}

function readJsonLines(file: string): unknown[] {
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const records: unknown[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// A damaged line must not make all local memory unavailable.
		}
	}
	return records;
}

function normalizeMemory(memory: DurableMemory): DurableMemory {
	return {
		...memory,
		layer: memory.layer ?? "durable",
		status: memory.status ?? "provisional",
	};
}

function isDurableMemory(value: unknown): value is DurableMemory {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === MEMORY_VERSION &&
		typeof record.id === "string" &&
		MEMORY_KINDS.has(record.kind as MemoryKind) &&
		typeof record.createdAt === "string" &&
		!Number.isNaN(Date.parse(record.createdAt)) &&
		typeof record.sourceEntryId === "string" &&
		typeof record.content === "string" &&
		record.content.trim().length > 0 &&
		(record.layer === undefined || MEMORY_LAYERS.has(record.layer as MemoryLayer)) &&
		(record.status === undefined || MEMORY_STATUSES.has(record.status as MemoryStatus))
	);
}

function isMemoryAction(value: unknown): value is MemoryAction {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === MEMORY_VERSION &&
		typeof record.id === "string" &&
		typeof record.createdAt === "string" &&
		!Number.isNaN(Date.parse(record.createdAt)) &&
		typeof record.memoryId === "string" &&
		ACTION_TYPES.has(record.type as MemoryActionType)
	);
}

const MEMORY_KINDS: ReadonlySet<MemoryKind> = new Set([
	"compaction_summary", "fact", "preference", "decision", "project_state",
]);
const MEMORY_LAYERS: ReadonlySet<MemoryLayer> = new Set(["recent", "durable", "pinned"]);
const MEMORY_STATUSES: ReadonlySet<MemoryStatus> = new Set([
	"provisional", "confirmed", "forgotten", "conflicted",
]);
const ACTION_TYPES: ReadonlySet<MemoryActionType> = new Set([
	"confirm", "correct", "forget", "pin", "unpin", "conflict", "resolve",
]);

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

function ensureStateDir(stateDir: string): void {
	mkdirSync(stateDir, { recursive: true });
}
