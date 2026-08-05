import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Schema version stamped on every persisted signal record. */
export const STATE_VERSION = 1;

/** File that stores append-only signal records (JSONL). */
const SIGNALS_FILE = "signals.jsonl";

/** File that stores the human-readable evolution audit trail. */
const JOURNAL_FILE = "evolution_journal.md";

/** State directory name owned by this extension under the agent dir. */
const AGENT_SUITE_DIR = "agent-suite";

/** Extension directory name used for all state files. */
const EXTENSION_STATE_DIR = "memory-evolution";

/** Persistent state surface of this extension. */
export interface StateStore {
	readonly stateDir: string;
	appendSignal(record: Record<string, unknown>): void;
	appendJournal(line: string): void;
}

/** Resolves the extension state directory from the pi agent directory. */
export function getStateDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, AGENT_SUITE_DIR, EXTENSION_STATE_DIR);
}

/** Creates a store writing into the given state directory. */
export function createStateStore(stateDir: string): StateStore {
	ensureStateDir(stateDir);
	return {
		stateDir,
		appendSignal: (record) =>
			appendSignal(stateDir, record),
		appendJournal: (line) => appendJournal(stateDir, line),
	};
}

/** Appends one versioned signal record as a JSONL line. */
function appendSignal(stateDir: string, record: Record<string, unknown>): void {
	ensureStateDir(stateDir);
	appendFileSync(
		join(stateDir, SIGNALS_FILE),
		`${JSON.stringify({ version: STATE_VERSION, ...record })}\n`,
	);
}

/** Appends one audit line to the evolution journal. */
function appendJournal(stateDir: string, line: string): void {
	ensureStateDir(stateDir);
	appendFileSync(join(stateDir, JOURNAL_FILE), `${line}\n`);
}

/** Creates the state directory when it does not yet exist. */
function ensureStateDir(stateDir: string): void {
	mkdirSync(stateDir, { recursive: true });
}
