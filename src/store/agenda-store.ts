import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** File that stores append-only signal records (JSONL). */
const SIGNALS_FILE = "signals.jsonl";

/** File that stores the human-readable evolution audit trail. */
const JOURNAL_FILE = "evolution_journal.md";

/** File that stores the current agenda items. */
const AGENDA_FILE = "self_agenda.yaml";

/** File that stores matured agenda candidates. */
const CANDIDATES_FILE = "agenda_candidates.yaml";

/** Schema version stamped on every persisted agenda file. */
export const AGENDA_VERSION = 1;

/** Schema version stamped on every persisted signal record. */
const SIGNAL_VERSION = 1;

/** Counters that track agenda item observation. */
export interface AgendaCounters {
	readonly evidenceCount: number;
	readonly observationDays: number;
	readonly recentMentions7d: number;
}

/** Score components of one agenda item. */
export interface AgendaScores {
	readonly evidenceStrength: number;
	readonly trendStrength: number;
	readonly recurrenceDensity: number;
	readonly unresolvedCost: number;
	readonly actionability: number;
	readonly timePressureBonus: number;
	readonly stalenessPenalty: number;
	readonly maturityScore: number;
}

/** Keyword and source matchers that bind signals to one agenda item. */
export interface AgendaMatchers {
	readonly signalTypes: readonly string[];
	readonly includeKeywords: readonly string[];
	readonly excludeKeywords: readonly string[];
}

/** One long-term agenda item tracked by the maturation engine. */
export interface AgendaItem {
	readonly id: string;
	readonly title: string;
	readonly type: string;
	readonly status: string;
	readonly firstSeenAt: string;
	readonly lastEvidenceAt: string;
	readonly lastSurfacedAt: string | null;
	readonly evidence: readonly AgendaEvidence[];
	readonly counters: AgendaCounters;
	readonly scores: AgendaScores;
	readonly evidenceMatchers: AgendaMatchers;
}

/** One evidence record attached to an agenda item. */
export interface AgendaEvidence {
	readonly at: string;
	readonly source: string;
	readonly summary: string;
	readonly weight: number;
	readonly qualified: boolean;
	readonly actionable: boolean;
	readonly relevance: number;
	readonly contribution: number;
}

/** One matured candidate emitted to agenda_candidates.yaml. */
export interface AgendaCandidate {
	readonly candidateId: string;
	readonly agendaId: string;
	readonly title: string;
	readonly type: string;
	readonly maturityScore: number;
	readonly action: string;
	readonly status: string;
	readonly evidenceCount: number;
	readonly observationDays: number;
	readonly suggestedMessage: string;
}

/** Persistent agenda state surface of this extension. */
export interface AgendaStore {
	readonly stateDir: string;
	appendSignal(record: Record<string, unknown>): void;
	appendJournal(line: string): void;
	readSignals(): Record<string, unknown>[];
	readAgenda(): AgendaItem[];
	writeAgenda(items: readonly AgendaItem[]): void;
	writeCandidates(candidates: readonly AgendaCandidate[]): void;
}

/** Creates an agenda store writing into the given state directory. */
export function createAgendaStore(stateDir: string): AgendaStore {
	ensureStateDir(stateDir);
	return {
		stateDir,
		appendSignal: (record) => appendSignal(stateDir, record),
		appendJournal: (line) => appendJournal(stateDir, line),
		readSignals: () => readSignals(stateDir),
		readAgenda: () => readAgenda(stateDir),
		writeAgenda: (items) => writeAgenda(stateDir, items),
		writeCandidates: (candidates) =>
			writeCandidates(stateDir, candidates),
	};
}

/** Appends one versioned signal record as a JSONL line. */
function appendSignal(stateDir: string, record: Record<string, unknown>): void {
	ensureStateDir(stateDir);
	appendFileSync(
		join(stateDir, SIGNALS_FILE),
		`${JSON.stringify({ version: SIGNAL_VERSION, ...record })}\n`,
	);
}

/** Appends one audit line to the evolution journal. */
function appendJournal(stateDir: string, line: string): void {
	ensureStateDir(stateDir);
	appendFileSync(join(stateDir, JOURNAL_FILE), `${line}\n`);
}

/** Reads all signal records from signals.jsonl. */
function readSignals(stateDir: string): Record<string, unknown>[] {
	const file = join(stateDir, SIGNALS_FILE);
	if (!fileExists(file)) {
		return [];
	}
	return readJsonl(file);
}

/** Reads agenda items from self_agenda.yaml. */
function readAgenda(stateDir: string): AgendaItem[] {
	const file = join(stateDir, AGENDA_FILE);
	if (!fileExists(file)) {
		return [];
	}
	const content = readFileSync(file, "utf8");
	if (content.trim().length === 0) {
		return [];
	}
	const parsed = JSON.parse(content);
	return Array.isArray(parsed.items) ? parsed.items : [];
}

/** Writes agenda items to self_agenda.yaml. */
function writeAgenda(stateDir: string, items: readonly AgendaItem[]): void {
	ensureStateDir(stateDir);
	writeFileSync(
		join(stateDir, AGENDA_FILE),
		`${JSON.stringify(
			{ version: AGENDA_VERSION, items },
			null,
			2,
		)}\n`,
	);
}

/** Writes matured candidates to agenda_candidates.yaml. */
function writeCandidates(
	stateDir: string,
	candidates: readonly AgendaCandidate[],
): void {
	ensureStateDir(stateDir);
	writeFileSync(
		join(stateDir, CANDIDATES_FILE),
		`${JSON.stringify(
			{ version: AGENDA_VERSION, shadow_mode: true, candidates },
			null,
			2,
		)}\n`,
	);
}

/** Reads every line of a JSONL file as parsed records. */
function readJsonl(file: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			records.push(JSON.parse(line));
		} catch {
			continue;
		}
	}
	return records;
}

/** Returns true when a file exists on disk. */
function fileExists(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Creates the state directory when it does not yet exist. */
function ensureStateDir(stateDir: string): void {
	mkdirSync(stateDir, { recursive: true });
}
