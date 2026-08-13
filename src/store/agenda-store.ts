import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** File that stores append-only signal records (JSONL). */
const SIGNALS_FILE = "signals.jsonl";

/** File that stores the human-readable evolution audit trail. */
const JOURNAL_FILE = "evolution_journal.md";

/** File that stores the current agenda items. */
const AGENDA_FILE = "self_agenda.yaml";

/** File that stores matured agenda candidates. */
const CANDIDATES_FILE = "agenda_candidates.yaml";

/** File that stores daily speak quota usage. */
const QUOTA_FILE = "speak_quota.json";

/** File that stores append-only speak gate decisions. */
const DECISIONS_FILE = "speak_decisions.jsonl";

/** File that stores the user-approved proposal queue. */
const PROPOSAL_FILE = "proposal_queue.yaml";

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
	/** Evidence records carried from the agenda item (older files may omit it). */
	readonly evidence?: readonly AgendaEvidence[];
}

/** Daily speak quota counters reset on date change. */
export interface SpeakQuota {
	readonly date: string;
	readonly suggestions: number;
	readonly strategic: number;
}

/** One traceable speak-gate decision. */
export interface SpeakDecision {
	readonly candidateId: string;
	readonly agendaId: string;
	readonly title: string;
	readonly priorityScore: number;
	readonly speakScore: number;
	readonly action: string;
	readonly wouldHaveSpokenWithoutQuota: boolean;
	readonly decisionReason: readonly string[];
}

/** Lifecycle states of one proposal (approved P5 plan). */
export type ProposalStatus =
	| "draft"
	| "pending_user_approval"
	| "approved"
	| "implemented"
	| "verified"
	| "rejected"
	| "failed"
	| "rollback_required";

/** One proposal waiting for approval and lifecycle handling. */
export interface ProposalRecord {
	readonly id: string;
	readonly title: string;
	readonly type: string;
	readonly status: ProposalStatus;
	readonly evidence: readonly AgendaEvidence[];
	readonly approval: {
		readonly required: boolean;
		readonly approvedBy: string | null;
		readonly approvedAt: string | null;
	};
	readonly timestamps: {
		readonly createdAt: string;
		readonly updatedAt: string;
		readonly expiresAt: string;
	};
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
	readCandidates(): AgendaCandidate[];
	readQuota(): SpeakQuota;
	writeQuota(quota: SpeakQuota): void;
	readDecisions(): SpeakDecision[];
	appendDecision(decision: SpeakDecision): void;
	readProposalQueue(): ProposalRecord[];
	writeProposalQueue(proposals: readonly ProposalRecord[]): void;
	writeExecutionPlan(planId: string, content: string): void;
	readExecutionPlan(planId: string): string | undefined;
	archiveExecutionPlan(planId: string): boolean;
	readArchivedPlan(planId: string): string | undefined;
	purgeExpiredArchives(now: string, retentionDays: number): number;
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
		readCandidates: () => readCandidates(stateDir),
		readQuota: () => readQuota(stateDir),
		writeQuota: (quota) => writeQuota(stateDir, quota),
		readDecisions: () => readDecisions(stateDir),
		appendDecision: (decision) =>
			appendDecision(stateDir, decision),
		readProposalQueue: () => readProposalQueue(stateDir),
		writeProposalQueue: (proposals) =>
			writeProposalQueue(stateDir, proposals),
		writeExecutionPlan: (planId, content) =>
			writeExecutionPlan(stateDir, planId, content),
		readExecutionPlan: (planId) =>
			readExecutionPlan(stateDir, planId),
		archiveExecutionPlan: (planId) =>
			archiveExecutionPlan(stateDir, planId),
		readArchivedPlan: (planId) =>
			readArchivedPlan(stateDir, planId),
		purgeExpiredArchives: (now, retentionDays) =>
			purgeExpiredArchives(stateDir, now, retentionDays),
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

/** Reads candidates from agenda_candidates.yaml. */
function readCandidates(stateDir: string): AgendaCandidate[] {
	const file = join(stateDir, CANDIDATES_FILE);
	if (!fileExists(file)) {
		return [];
	}
	const content = readFileSync(file, "utf8");
	if (content.trim().length === 0) {
		return [];
	}
	const parsed = JSON.parse(content);
	return Array.isArray(parsed.candidates) ? parsed.candidates : [];
}

/** Reads today's speak quota, resetting when the date changed. */
function readQuota(stateDir: string): SpeakQuota {
	const file = join(stateDir, QUOTA_FILE);
	const today = todayStr();
	if (!fileExists(file)) {
		return { date: today, suggestions: 0, strategic: 0 };
	}
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed.date === today) {
			return parsed;
		}
	} catch {
		return { date: today, suggestions: 0, strategic: 0 };
	}
	return { date: today, suggestions: 0, strategic: 0 };
}

/** Persists the current daily speak quota. */
function writeQuota(stateDir: string, quota: SpeakQuota): void {
	ensureStateDir(stateDir);
	writeFileSync(
		join(stateDir, QUOTA_FILE),
		`${JSON.stringify(quota, null, 2)}\n`,
	);
}

/** Reads all speak gate decisions from the append-only log. */
function readDecisions(stateDir: string): SpeakDecision[] {
	const file = join(stateDir, DECISIONS_FILE);
	if (!fileExists(file)) {
		return [];
	}
	const decisions: SpeakDecision[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			decisions.push(JSON.parse(line));
		} catch {
			continue;
		}
	}
	return decisions;
}

/** Appends one speak decision to the traceable log. */
function appendDecision(stateDir: string, decision: SpeakDecision): void {
	ensureStateDir(stateDir);
	appendFileSync(join(stateDir, DECISIONS_FILE), `${JSON.stringify(decision)}\n`);
}

/** Reads the user-approved proposal queue. */
function readProposalQueue(stateDir: string): ProposalRecord[] {
	const file = join(stateDir, PROPOSAL_FILE);
	if (!fileExists(file)) {
		return [];
	}
	const content = readFileSync(file, "utf8");
	if (content.trim().length === 0) {
		return [];
	}
	const parsed = JSON.parse(content);
	return Array.isArray(parsed.proposals) ? parsed.proposals : [];
}

/** Writes the user-approved proposal queue. */
function writeProposalQueue(
	stateDir: string,
	proposals: readonly ProposalRecord[],
): void {
	ensureStateDir(stateDir);
	writeFileSync(
		join(stateDir, PROPOSAL_FILE),
		`${JSON.stringify(
			{ version: AGENDA_VERSION, proposals },
			null,
			2,
		)}\n`,
	);
}

/** Subdirectory holding one markdown execution plan per implemented proposal. */
const EXECUTIONS_DIR = "executions";

/** Subdirectory holding archived execution plans of terminal proposals. */
const EXECUTIONS_ARCHIVE_DIR = "archive";

/** Writes one execution plan markdown file for a proposal. */
function writeExecutionPlan(
	stateDir: string,
	planId: string,
	content: string,
): void {
	ensureStateDir(stateDir);
	mkdirSync(join(stateDir, EXECUTIONS_DIR), { recursive: true });
	writeFileSync(
		join(stateDir, EXECUTIONS_DIR, `${planId}.md`),
		content,
	);
}

/** Reads one execution plan markdown file, or undefined when missing. */
function readExecutionPlan(stateDir: string, planId: string): string | undefined {
	const file = join(stateDir, EXECUTIONS_DIR, `${planId}.md`);
	if (!fileExists(file)) {
		return undefined;
	}
	return readFileSync(file, "utf8");
}

/** Moves an execution plan into executions/archive/, or false when missing. */
function archiveExecutionPlan(stateDir: string, planId: string): boolean {
	const source = join(stateDir, EXECUTIONS_DIR, `${planId}.md`);
	if (!fileExists(source)) {
		return false;
	}
	mkdirSync(join(stateDir, EXECUTIONS_DIR, EXECUTIONS_ARCHIVE_DIR), {
		recursive: true,
	});
	renameSync(source, join(stateDir, EXECUTIONS_DIR, EXECUTIONS_ARCHIVE_DIR, `${planId}.md`));
	return true;
}

/** Reads one archived execution plan, or undefined when missing. */
function readArchivedPlan(stateDir: string, planId: string): string | undefined {
	const file = join(
		stateDir,
		EXECUTIONS_DIR,
		EXECUTIONS_ARCHIVE_DIR,
		`${planId}.md`,
	);
	if (!fileExists(file)) {
		return undefined;
	}
	return readFileSync(file, "utf8");
}

/** Deletes archived plans older than the retention window, returning the count. */
function purgeExpiredArchives(
	stateDir: string,
	now: string,
	retentionDays: number,
): number {
	const archiveDir = join(stateDir, EXECUTIONS_DIR, EXECUTIONS_ARCHIVE_DIR);
	let entries: string[] = [];
	try {
		entries = readdirSync(archiveDir);
	} catch {
		return 0;
	}
	const cutoff = Date.parse(now) - retentionDays * 24 * 3_600_000;
	let purged = 0;
	for (const entry of entries) {
		if (!entry.endsWith(".md")) {
			continue;
		}
		const file = join(archiveDir, entry);
		const mtime = statSync(file).mtimeMs;
		if (mtime < cutoff) {
			unlinkSync(file);
			purged++;
		}
	}
	return purged;
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

/** Returns today's date as YYYY-MM-DD in UTC. */
function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}
