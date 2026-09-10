import { openDatabase, type Database } from "./sqlite.ts";
import { features, mentions } from "./search.ts";
import { MAX_CANDIDATES, MAX_CLAIMS, RELATED_CONTAINMENT } from "./limits.ts";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { extractStructuredMemories, MAX_CLAIM_CHARS, MIN_CLAIM_CHARS, type Claim } from "./extractor.ts";
import { loadLegacyImport, emptyLegacyDigest } from './legacy.ts';
import { legacyFiles } from './legacy-files.ts';
import { clipBytes, fingerprint, redact } from "./privacy.ts";
import { validSearchTerms } from "./search.ts";
import { sourceEvidence, validEvidence, validFeedback, mayReplace, FEEDBACK_VERDICTS, type Evidence, type MemoryFeedback, type FeedbackVerdict } from "./quality.ts";
import { EVOLUTION_TIMEOUT_MS, LEASE_GRACE_MS, MAX_FAILURES, MAX_OUTPUT_FAILURES, PAUSED_SQL, FAILURE_CODES, EvolutionError, retryAt, type FailureCode } from "./recovery.ts";
import { modelLabel, OUTPUT_PROTOCOL_VERSION, parseDiagnostic, validDiagnostic, type Diagnostic, type DiagnosticReason } from './diagnostics.ts';
import { SCHEMA_VERSION, SUPPORTED_SCHEMAS } from './limits.ts';
import { budgetUntil, reserveCall, finishCall, takeNotice, routeUntil, estimatedCost, type CallOptions } from './processing-state.ts';
import { loadRoutingPolicy, type RoutingPolicy } from './routing-policy.ts';

export type RetryMode = boolean | 'auto' | 'fallback';
const pausedSQL = (p: RoutingPolicy) => `(${PAUSED_SQL} OR calls>=${p.sourceCalls} OR call_ms>=${p.sourceTimeMs})`;
// Selection and claim both check source budgets; route/global waits never modify source retry_at.
const automaticEligibility = (p: RoutingPolicy) => `((state='pending' OR state='failed') AND NOT ${pausedSQL(p)} AND retry_at<=?)`;

export type MemoryKind = "fact" | "preference" | "decision" | "project_state";
export interface DurableMemory {
	id: string;
	kind: MemoryKind;
	content: string;
	/** Capture origin, not a recall boundary or a guaranteed project identity. */
	scope: string;
	sourceEntryId: string;
	createdAt: string;
	updatedAt: string;
	revision: number;
	layer: "durable" | "pinned";
	status: "provisional" | "confirmed" | "forgotten" | "conflicted";
	/** Exact superseded content, carried across explicit legacy adoption. */
	suppressedHashes?: string[];
	searchTerms?: string[];
	/** When this record was last confirmed by later evidence, as distinct from last changed. Decay
	 * and dormancy run from it; `updatedAt` does not move, because it is the replacement authority
	 * gate and moving it would make a refreshed record refuse a legitimately older queued source.
	 * Missing on records nothing has reconfirmed, which simply means decay runs from `updatedAt`. */
	reinforcedAt?: string;
	/** Host-assigned provenance; missing on old records means unknown, never verified. */
	evidence?: Evidence;
	feedback?: MemoryFeedback;
}
export interface Source {
	id: string;
	scope: string;
	kind: "summary" | "user" | "progress";
	content: string;
	createdAt: string;
	/** Host-selected existing project-state IDs; tools cannot nominate their own targets. */
	targets?: string[];
}
export interface EvolutionRun {
	source: Source;
	attempt: number;
	generation: number;
	/** Everything the host may reason about locally: duplicate detection and alias enrichment. */
	memories: DurableMemory[];
	/** The subset actually shown to the model, and therefore the only records it may name in
	 * `replaces`. Naming anything else means it invented an ID it was never given. */
	candidates: DurableMemory[];
	outputFailures: number;
	previousError: FailureCode | '';
	previousDiagnostic: Diagnostic;
	timeoutMs: number;
	correctOutput: boolean;
}
interface Event {
	id: string;
	at: string;
	scope: string;
	actor: string;
	reason: string;
	before: (DurableMemory | null)[];
	after: DurableMemory[];
}
export type MemoryAction = "correct" | "forget" | "pin" | "unpin" | "conflict" | "resolve" | "adopt";
export const MEMORY_KINDS = new Set<MemoryKind>(["fact", "preference", "decision", "project_state"]);
const active = (m: DurableMemory) => m.status !== "forgotten" && m.status !== "conflicted";

/** One transactional database: no cross-file commits, process locks or replay scans. */
export class MemoryStore {
	private db: Database;
	private cache = new Map<string, { version: number; memories: DurableMemory[] }>();
	readonly stateDir: string;
	readonly policy: RoutingPolicy;
	constructor(stateDir: string) {
		this.stateDir = stateDir;
		this.policy = loadRoutingPolicy(stateDir);
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const file = join(stateDir, "memory.sqlite");
		try { const fd = openSync(file, "wx", 0o600); closeSync(fd); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Memory database must be a regular file");
		chmodSync(file, 0o600);
		this.db = openDatabase(file);
		try {
			if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get()) {
				const schema = this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get();
				if (schema && !SUPPORTED_SCHEMAS.includes(String(schema.value))) throw new Error("Unsupported memory database version");
			}
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
				CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL);
				CREATE INDEX IF NOT EXISTS memories_scope_hash ON memories(scope,hash);
				CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0, lease INTEGER NOT NULL DEFAULT 0);
				CREATE INDEX IF NOT EXISTS sources_scope_state ON sources(json_extract(data,'$.scope'),state);
				CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);
				CREATE INDEX IF NOT EXISTS events_scope ON events(scope);
				CREATE TABLE IF NOT EXISTS blocked (scope TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(scope,hash));`);
			this.transaction(() => {
				const schema = this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get();
				if (schema && !SUPPORTED_SCHEMAS.includes(String(schema.value))) throw new Error("Unsupported memory database version");
				if (!["4", "5", "6", "7"].includes(String(schema?.value))) {
					const columns = new Set(this.db.prepare("PRAGMA table_info(sources)").all().map((r) => r.name));
					for (const [name, type] of [["failures", "INTEGER NOT NULL DEFAULT 0"], ["retry_at", "INTEGER NOT NULL DEFAULT 0"],
						["failed_at", "INTEGER NOT NULL DEFAULT 0"], ["last_error", "TEXT NOT NULL DEFAULT ''"]]) {
						if (!columns.has(name)) this.db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`);
					}
					// Old errors have no known cause/time. Make them eligible without inventing either.
					this.db.exec("UPDATE sources SET failures=MIN(MAX(attempt,1),5),last_error='unknown' WHERE state='failed' AND failures=0");
				}
				const columns = new Set(this.db.prepare('PRAGMA table_info(sources)').all().map(r => r.name));
				for (const [name, type] of [['output_failures', 'INTEGER NOT NULL DEFAULT 0'], ['diagnostic', "TEXT NOT NULL DEFAULT '{}'"], ['calls', 'INTEGER NOT NULL DEFAULT 0'], ['call_ms', 'INTEGER NOT NULL DEFAULT 0'], ['call_models', "TEXT NOT NULL DEFAULT '[]'"], ['last_checked', 'INTEGER NOT NULL DEFAULT 0'], ['corrections', 'INTEGER NOT NULL DEFAULT 0']]) {
					if (!columns.has(name)) this.db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`);
				}
				// Historical attempts have no detailed response history. Preserve their budgets, don't invent counts.
				this.db.exec(`CREATE TABLE IF NOT EXISTS model_calls (source_id TEXT NOT NULL, attempt INTEGER NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL,
					outcome TEXT NOT NULL DEFAULT 'running', finished_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source_id,attempt));
					CREATE INDEX IF NOT EXISTS model_calls_window ON model_calls(model,at);
					CREATE INDEX IF NOT EXISTS model_failures_window ON model_calls(model,finished_at) WHERE outcome='failed';
					CREATE TABLE IF NOT EXISTS recovery_notices (id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
				const callColumns = new Set(this.db.prepare('PRAGMA table_info(model_calls)').all().map(r => r.name));
				for (const [name, type] of [['provider', "TEXT NOT NULL DEFAULT ''"], ['code', "TEXT NOT NULL DEFAULT ''"], ['reserved_usd', 'REAL'], ['charged_usd', 'REAL'], ['input_tokens', 'INTEGER'], ['output_tokens', 'INTEGER']]) {
					if (!callColumns.has(name)) this.db.exec(`ALTER TABLE model_calls ADD COLUMN ${name} ${type}`);
				}
				this.db.exec('CREATE TABLE IF NOT EXISTS route_health (id TEXT PRIMARY KEY, until INTEGER NOT NULL, code TEXT NOT NULL)');
				if (schema?.value === '6') {
					// v6 mixed route waits into source backoff. Restore only the known v6 scheduling formula.
					this.db.exec("UPDATE sources SET retry_at=0 WHERE state='pending'");
					for (const row of this.db.prepare("SELECT id,failures,failed_at FROM sources WHERE state='failed' AND failed_at>0").all())
						this.db.prepare('UPDATE sources SET retry_at=MIN(retry_at,?) WHERE id=?').run(retryAt(Number(row.failures), Number(row.failed_at)), row.id);
					for (const row of this.db.prepare('SELECT source_id,COUNT(*) AS n FROM model_calls GROUP BY source_id').all())
						this.db.prepare('UPDATE sources SET calls=? WHERE id=?').run(row.n, row.source_id);
					for (const row of this.db.prepare('SELECT id FROM sources WHERE calls>0').all()) {
						const models = this.db.prepare('SELECT DISTINCT model FROM model_calls WHERE source_id=?').all(row.id).map(r => String(r.model));
						this.db.prepare('UPDATE sources SET call_models=? WHERE id=?').run(JSON.stringify(models), row.id);
					}
				}
				this.db.exec("CREATE INDEX IF NOT EXISTS sources_recovery ON sources(state,retry_at); CREATE INDEX IF NOT EXISTS sources_running_lease ON sources(lease) WHERE state='running'");
				this.db.exec("CREATE TABLE IF NOT EXISTS feedback_receipts (source_id TEXT NOT NULL, memory_id TEXT NOT NULL, verdict TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(source_id,memory_id)); CREATE INDEX IF NOT EXISTS feedback_recent ON feedback_receipts(memory_id,verdict,at)");
				if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='legacy_import'").get()) {
					const imported = this.db.prepare("SELECT 1 FROM events WHERE json_extract(data,'$.actor')='migration' LIMIT 1").get();
					const legacy = this.db.prepare("SELECT 1 FROM memories WHERE scope='legacy' LIMIT 1").get();
					this.setImportState({ state: !schema ? 'pending' : imported ? 'completed' : legacy ? 'unknown' : 'not_found' });
				}
				const imported = this.importState();
				if (imported.state === 'completed' && imported.count === 0 && emptyLegacyDigest(imported.digest)
					&& !this.db.prepare("SELECT 1 FROM events WHERE json_extract(data,'$.actor')='migration' LIMIT 1").get()) this.setImportState({ state: 'not_found' });
				this.db.prepare("INSERT INTO metadata VALUES ('schema',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SCHEMA_VERSION);
			});
			if (this.importState().state === 'pending') {
				try { this.importLegacy(); } catch { /* Persisted failure blocks learning but leaves status/repair commands available. */ }
			}
		} catch (error) { this.db.close(); throw error; }
	}
	close(): void { this.db.close(); }
	private importState(): { state: 'pending' | 'not_found' | 'completed' | 'failed' | 'unknown'; count?: number; digest?: string } {
		const value = JSON.parse(String(this.db.prepare("SELECT value FROM metadata WHERE key='legacy_import'").get()?.value));
		if (!value || !['pending', 'not_found', 'completed', 'failed', 'unknown'].includes(value.state)
			|| Object.keys(value).some(k => !['state', 'count', 'digest'].includes(k))
			|| (value.count !== undefined && (!Number.isSafeInteger(value.count) || value.count < 0))
			|| (value.digest !== undefined && (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest)))) throw new Error('Invalid legacy import metadata');
		return value;
	}
	private setImportState(value: ReturnType<MemoryStore['importState']>): void {
		this.db.prepare("INSERT INTO metadata VALUES ('legacy_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
	}
	private assertLearningReady(): void {
		if (['pending', 'failed'].includes(this.importState().state)) throw new EvolutionError('unavailable', { reason: 'legacy_import_failed' });
	}
	/** One ledger set per database; completed/unknown old imports are never replayed over newer edits. */
	importLegacy(directory = this.stateDir): { state: string; imported: number } {
		const state = this.importState().state;
		if (state === 'completed' || state === 'unknown') return { state, imported: 0 };
		try {
			const snapshot = loadLegacyImport(resolve(directory));
			return this.transaction(() => {
				const current = this.importState().state;
				if (current === 'completed' || current === 'unknown') return { state: current, imported: 0 };
				if (!snapshot.found || !snapshot.hasRecords) {
					// A failed import cannot be bypassed by pointing at an empty directory.
					if (current !== 'failed') this.setImportState({ state: 'not_found' });
					return { state: current === 'failed' ? 'failed' : 'not_found', imported: 0 };
				}
				const memories = snapshot.memories.filter(memory => {
					if (this.get(memory.id)) throw new Error('Legacy memory ID collision; no existing record overwritten');
					return !active(memory) || !this.db.prepare('SELECT 1 FROM blocked WHERE scope=? AND hash=?').get(memory.scope, fingerprint(memory.content));
				});
				if (memories.length) this.record('migration', 'Import legacy JSONL; originals unchanged', memories, 'legacy');
				this.setImportState({ state: 'completed', count: memories.length, digest: snapshot.digest });
				return { state: 'completed', imported: memories.length };
			});
		} catch {
			this.transaction(() => {
				if (!['completed', 'unknown'].includes(this.importState().state)) this.setImportState({ state: 'failed' });
			});
			throw new Error('Legacy import failed; inspect both ledgers, originals and database memories unchanged');
		}
	}
	legacyStatus(): string {
		const state = this.importState();
		const obsolete = legacyFiles(this.stateDir);
		return `Legacy import: ${state.state}${state.count === undefined ? '' : `; imported=${state.count}`}. ${state.state === 'failed' ? 'Learning blocked until repaired; ' : ''}/memory import [directory] imports one ledger set, never replays a completed import.\nLegacy inactive files: ${obsolete.join(', ') || 'none'}; never executed/imported. /memory archive-legacy creates a copy-only backup.`;
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const value = fn(); this.db.exec("COMMIT"); this.cache.clear(); return value; }
		catch (error) { this.db.exec("ROLLBACK"); this.cache.clear(); throw error; }
	}
	readMemories(scope?: string): DurableMemory[] {
		const version = Number(this.db.prepare("PRAGMA data_version").get()!.data_version);
		const key = scope ?? "";
		let cached = this.cache.get(key);
		if (!cached || cached.version !== version) {
			const rows = scope === undefined ? this.db.prepare("SELECT id,scope,hash,data FROM memories").all()
				: this.db.prepare("SELECT id,scope,hash,data FROM memories WHERE scope=?").all(scope);
			const memories = rows.map((row) => {
				const memory: unknown = JSON.parse(String(row.data));
				if (!isMemory(memory) || memory.id !== row.id || memory.scope !== row.scope || fingerprint(memory.content) !== row.hash) throw new Error("Invalid memory record; recall stopped");
				return memory;
			});
			cached = { version, memories };
			this.cache.set(key, cached);
		}
		return cached.memories.map((m) => structuredClone(m));
	}
	private get(id: string): DurableMemory | undefined {
		const row = this.db.prepare("SELECT scope,hash,data FROM memories WHERE id=?").get(id);
		if (!row) return undefined;
		const data: unknown = JSON.parse(String(row.data));
		if (!isMemory(data) || data.id !== id || data.scope !== row.scope || fingerprint(data.content) !== row.hash) throw new Error("Invalid memory record");
		return data;
	}
	private generation(scope: string): number {
		return Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM events WHERE scope=?").get(scope)!.n);
	}
	/** Confirmation is not a change: no content, evidence, status or `updatedAt` moves, so it writes
	 * no event and creates no undo point - there is nothing to undo about having been mentioned. Only
	 * `reinforcedAt` moves, and only forward, so replay or an out-of-order source cannot roll it back.
	 * Pinned records are skipped because their freshness is already fixed at 1. */
	private reinforce(ids: Iterable<string>, at: string): void {
		const stamp = Date.parse(at);
		if (!Number.isFinite(stamp)) return;
		let touched = false;
		for (const id of ids) {
			const memory = this.get(id);
			if (!memory || !active(memory) || memory.layer === "pinned") continue;
			if (stamp <= Math.max(Date.parse(memory.updatedAt), Date.parse(memory.reinforcedAt ?? "") || 0)) continue;
			const next = { ...memory, reinforcedAt: new Date(stamp).toISOString() };
			if (!isMemory(next)) throw new Error("Invalid memory update");
			this.db.prepare("UPDATE memories SET data=? WHERE id=?").run(JSON.stringify(next), id);
			touched = true;
		}
		if (touched) this.cache.clear();
	}
	private record(actor: string, reason: string, after: DurableMemory[], scope: string): string {
		const before = after.map((m) => this.get(m.id) ?? null);
		const at = new Date().toISOString();
		const event: Event = { id: randomUUID(), at, actor, reason, scope, before, after };
		for (const memory of after) {
			if (!isMemory(memory)) throw new Error("Invalid memory update");
			this.db.prepare("INSERT INTO memories VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,hash=excluded.hash,data=excluded.data")
				.run(memory.id, memory.scope, fingerprint(memory.content), JSON.stringify(memory));
			for (const hash of memory.suppressedHashes ?? [])
				this.db.prepare("INSERT OR IGNORE INTO blocked VALUES (?,?)").run(memory.scope, hash);
		}
		this.db.prepare("INSERT INTO events VALUES (?,?,?)").run(event.id, scope, JSON.stringify(event));
		this.cache.clear();
		return event.id;
	}
	private block(memory: DurableMemory, keepSource?: string): void {
		const hash = fingerprint(memory.content);
		this.db.prepare("INSERT OR IGNORE INTO blocked VALUES (?,?)").run(memory.scope, hash);
		const original = this.db.prepare("SELECT data FROM sources WHERE id=?").get(memory.sourceEntryId);
		const body = original ? parseSource(original.data).content : undefined;
		// A claim may have been repeated in several sources, not only its first parent.
		const pending = this.db.prepare("SELECT id,data,attempt FROM sources WHERE json_extract(data,'$.scope')=? AND state!='done'").all(memory.scope);
		for (const row of pending) {
			if (row.id === keepSource) continue;
			const source = parseSource(row.data);
			if (source.id === memory.sourceEntryId || source.targets?.includes(memory.id) || source.content === body || source.content.includes(memory.content)
				|| extractStructuredMemories(source.content, Infinity).some((claim) => fingerprint(claim.content) === hash)) {
				finishCall(this.db, source.id, Number(row.attempt), 'cancelled', Date.now(), 'cancelled');
				this.db.prepare("UPDATE sources SET state='done',lease=0 WHERE id=?").run(source.id);
			}
		}
	}
	private claim(source: Source, item: Claim, method: "local" | "model" = "local"): DurableMemory | undefined {
		const content = redact(item.content).trim();
		if (!validSearchTerms(item.searchTerms) || !MEMORY_KINDS.has(item.kind) || content.length < MIN_CLAIM_CHARS || content.length > MAX_CLAIM_CHARS || content.includes("[REDACTED")) throw new Error("Invalid or sensitive claim");
		const id = fingerprint(JSON.stringify([source.scope, item.kind, content]));
		if (this.get(id) || this.db.prepare("SELECT 1 FROM blocked WHERE scope=? AND hash=?").get(source.scope, fingerprint(content))) return undefined;
		// Also respect forgotten legacy records whose ids predate content-addressing.
		if (this.db.prepare("SELECT 1 FROM memories WHERE scope=? AND hash=?").get(source.scope, fingerprint(content))) return undefined;
		return { id, kind: item.kind, content, scope: source.scope, sourceEntryId: source.id,
			createdAt: source.createdAt, updatedAt: source.createdAt, revision: 1, layer: "durable", status: "provisional",
			evidence: sourceEvidence(source, method),
			...(item.searchTerms ? { searchTerms: [...new Set(item.searchTerms)] } : {}) };
	}
	/** Persist raw evidence + bounded local claims once, atomically. Raw sources are never recalled. */
	capture(input: Source): boolean {
		this.assertLearningReady();
		if (!isSource(input)) throw new Error("Invalid memory source");
		const source = { ...input, createdAt: new Date(input.createdAt).toISOString(), content: clipBytes(redact(input.content), 32_000) };
		return this.transaction(() => {
			if (this.db.prepare("SELECT 1 FROM sources WHERE id=?").get(source.id)) return false;
			this.db.prepare("INSERT INTO sources(id,data) VALUES (?,?)").run(source.id, JSON.stringify(source));
			const claims = source.kind === "summary" ? extractStructuredMemories(source.content) : [];
			const memories = new Map<string, DurableMemory>();
			for (const claim of claims) {
				const memory = this.claim(source, claim);
				if (memory && !memories.has(fingerprint(memory.content))) memories.set(fingerprint(memory.content), memory);
			}
			this.record("local", `Capture ${source.id}`, [...memories.values()], source.scope);
			return true;
		});
	}
	pending(scope?: string, retry: RetryMode = false, now = Date.now()): string | undefined {
		const row = this.db.prepare(`SELECT id FROM sources WHERE ${scope === undefined ? "" : "json_extract(data,'$.scope')=? AND"}
			${retry === 'auto' ? automaticEligibility(this.policy) : `(state='pending' OR (state='running' AND lease<=?) ${retry ? "OR state='failed'" : ""})`}
			ORDER BY ${retry === 'auto' ? 'last_checked ASC, retry_at ASC, rowid ASC' : 'rowid DESC'} LIMIT 1`)
			.get(...(scope === undefined ? [] : [scope]), now);
		return row ? String(row.id) : undefined;
	}
	/** The single definition of what a source may reason about locally and what it may be shown.
	 * The reservation estimate and the run itself must call this same function: an estimate cheaper
	 * than the payload it authorizes is how a call gets admitted that the provider then refuses.
	 *
	 * A progress source arrives with its targets already nominated, so those are its candidates.
	 * For everything else the host drops records this source never mentions: it cannot supersede
	 * a fact it does not talk about, and retrieval is the host's job — deterministic and free —
	 * not something to pay a model to do by handing it every recent record to search through.
	 *
	 * `memories` is NOT read-only: `finishEvolution` writes through it, replacing `searchTerms`
	 * wholesale on an exact-content match and refreshing a duplicate's evidence. Those writes were
	 * always bounded by the recency window, and must stay bounded, or model output would rewrite
	 * records the model was never shown — losing aliases it could not have preserved and resetting
	 * the aging clock on records it never named. So `memories` is the recency window plus whatever
	 * was actually shown, and nothing else: `candidates` stays a subset, and every record the host
	 * may write through is one that was either recent or in front of the model. */
	private selectCandidates(source: Source): { memories: DurableMemory[]; candidates: DurableMemory[] } {
		const scoped = this.readMemories(source.scope).filter((m) => m.scope === source.scope && active(m)
			&& (source.kind !== "progress" || (m.kind === "project_state" && source.targets!.includes(m.id))))
			.sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
		// Order is left alone deliberately. Containment filters; it must never rank. See limits.ts.
		// The cap is applied AFTER the filter. Capping first hid every matching record that had aged
		// past the 32 most recent, so in any scope with more than 32 records an older one could never
		// be shown again, and therefore never superseded — only accumulated alongside.
		const vocabulary = source.kind === "progress" ? undefined : features(source.content);
		const candidates = (vocabulary === undefined ? scoped
			: scoped.filter((m) => mentions(vocabulary, m.content, m.searchTerms) >= RELATED_CONTAINMENT)).slice(0, MAX_CANDIDATES);
		const recent = scoped.slice(0, MAX_CANDIDATES);
		const known = new Set(recent.map((m) => m.id));
		// Older shown records follow the recency window in age order, so this stays recency-ordered.
		return { memories: [...recent, ...candidates.filter((m) => !known.has(m.id))], candidates };
	}

	beginEvolution(id: string, retry: RetryMode = false, timeoutMs = EVOLUTION_TIMEOUT_MS, now = Date.now(), model?: string, call?: CallOptions): EvolutionRun | undefined {
		this.assertLearningReady();
		return this.transaction(() => {
			const eligibility = retry === true ? `(state='pending' OR (state='running' AND lease<=?) OR state='failed')`
				: retry === 'fallback' ? `(state IN ('pending','failed') AND NOT ${pausedSQL(this.policy)} AND ? >= 0)` : automaticEligibility(this.policy);
			const row = this.db.prepare(`SELECT * FROM sources WHERE id=? AND ${eligibility}`).get(id, now);
			if (!row) return undefined;
			this.db.prepare('UPDATE sources SET last_checked=? WHERE id=?').run(now, id);
			const priorModels = parseModels(row.call_models);
			const correctOutput = Number(row.corrections) === 0 && Number(row.output_failures) === 1 && ['invalid_output','output_limit'].includes(String(row.last_error));
			const source = parseSource(row.data);
			// Selecting candidates scans the whole scope; this transaction holds the write lock, so it is
			// computed at most once per attempt and only once a route is actually available. The estimate
			// and the run must see the same set anyway — a cheaper estimate authorizes a larger payload.
			let selected: { memories: DurableMemory[]; candidates: DurableMemory[] } | undefined;
			const select = () => (selected ??= this.selectCandidates(source));
			if (model !== undefined) {
				model = modelLabel(model);
				if (retry !== true && !priorModels.includes(model) && priorModels.length >= this.policy.sourceModels) return undefined;
				const provider = modelLabel(call?.provider ?? model.split('/')[0]);
				if (retry !== true && routeUntil(this.db, model, provider, now) > now) return undefined;
				const bytes = Buffer.byteLength(JSON.stringify(source)) + select().candidates
					.reduce((sum,m) => sum + Buffer.byteLength(JSON.stringify(m)), 0);
				const reserve = estimatedCost(bytes, call);
				if (budgetUntil(this.db, model, now, this.policy, reserve) > now) return undefined;
				reserveCall(this.db, id, Number(row.attempt) + 1, model, now, provider, reserve);
				this.db.prepare('UPDATE sources SET calls=calls+1,call_models=?,corrections=corrections+? WHERE id=?').run(JSON.stringify([...new Set([...priorModels,model])]), Number(correctOutput), id);
			}
			timeoutMs = Math.min(timeoutMs, this.policy.timeoutMs, retry === true ? timeoutMs : Math.max(1, this.policy.sourceTimeMs - Number(row.call_ms)));
			this.db.prepare(`UPDATE sources SET state='running', attempt=attempt+1, lease=? WHERE id=?`).run(now + timeoutMs + LEASE_GRACE_MS, id);
			if (source.id !== id) throw new Error("Invalid source identity");
			const { memories, candidates } = select();
			// The stored diagnostic explains the last completed outcome. Claiming an attempt must not erase it:
			// a cancelled or interrupted run would otherwise leave a paused source with no recorded reason.
			return { source, attempt: Number(row.attempt) + 1, generation: this.generation(source.scope), memories, candidates, timeoutMs, correctOutput,
				outputFailures: Number(row.output_failures), previousDiagnostic: parseDiagnostic(row.diagnostic),
				previousError: FAILURE_CODES.includes(row.last_error as FailureCode) ? row.last_error as FailureCode : '' };
		});
	}
	finishEvolution(run: EvolutionRun, claims: Claim[], model: string, diagnostic: Diagnostic = {}): string {
		if (!validDiagnostic(diagnostic)) throw new Error('Invalid memory diagnostics');
		return this.transaction(() => {
			const job = this.db.prepare("SELECT state,attempt FROM sources WHERE id=?").get(run.source.id);
			if (job?.state !== "running" || job.attempt !== run.attempt || this.generation(run.source.scope) !== run.generation) throw new EvolutionError("stale");
			const after = new Map<string, DurableMemory>();
			const targets = new Set<string>();
			const confirmed = new Set<string>();
			const reaffirmed = new Set<string>();
			let weakerConflicts = 0;
			const incoming = sourceEvidence(run.source, "model");
			// Two different things used to throw the same bare Error and land on write_rejected, which
			// pauses a source for good and never even tells the model what it got wrong. They are not the
			// same: a broken output contract is the model's mistake, correctable and worth another model;
			// a refusal grounded in the store's own authority is not, because the same evidence will be
			// refused again. Only the first becomes invalid_output. The second keeps write_rejected below.
			const broke: (reason: DiagnosticReason, index: number, field?: string) => never = (reason, index, field) => {
				// The diagnostic field path only admits the contract's own indices; anything else stays 'result'.
				const at = index <= MAX_CLAIMS - 1 ? `memories[${index}]${field ? `.${field}` : ''}` : 'result';
				throw new EvolutionError('invalid_output', { ...diagnostic, reason, field: at });
			};
			const stage = (memory: DurableMemory) => {
				if (![...after.values()].some((m) => active(m) && fingerprint(m.content) === fingerprint(memory.content))) after.set(memory.id, memory);
			};
			// `claim()` below throws when the model's own output still redacts to a placeholder, meaning
			// it echoed something credential-shaped that the source-side redaction did not catch. Do NOT
			// wrap that in a correctable error: retrying resends the same unredacted source to another
			// call and, since invalid_output is sibling-eligible, to another provider. One exposure then
			// a stop is the cheap outcome; re-sending a secret to a second vendor is not. It stays a bare
			// Error, and therefore write_rejected, deliberately.
			const annotate = (memory: DurableMemory | undefined, claim: Claim) => {
				if (!memory || !claim.searchTerms || memory.layer === "pinned") return;
				const current = after.get(memory.id) ?? memory;
				const searchTerms = [...new Set(claim.searchTerms)];
				if (active(current) && JSON.stringify(current.searchTerms) !== JSON.stringify(searchTerms))
					after.set(memory.id, { ...current, searchTerms, revision: memory.revision + 1 });
			};
			for (const [index, claim] of claims.entries()) {
				if (!validSearchTerms(claim.searchTerms)) broke('invalid_aliases', index, 'searchTerms');
				if (run.source.kind === "progress" && (claim.kind !== "project_state" || !claim.replaces || !run.source.targets!.includes(claim.replaces)))
					broke('progress_contract', index);
				if (claim.replaces) {
					const old = run.candidates.find((m) => m.id === claim.replaces);
					// The model is shown exactly the records it may name, so naming another is its own error.
					if (!old) broke('unknown_replaces', index, 'replaces');
					if (targets.has(old.id)) broke('duplicate_replaces', index, 'replaces');
					if (run.source.kind === "progress" && old.kind !== "project_state") broke('replaces_kind', index, 'replaces');
					// Authority, not shape: a pinned record, another origin's record, or one already newer
					// than this source will refuse the same evidence however many times it is offered.
					if (old.scope !== run.source.scope || old.layer === "pinned"
						|| Date.parse(old.updatedAt) > Date.parse(run.source.createdAt)) throw new Error("Invalid replacement target");
					targets.add(old.id);
					if (claim.kind !== old.kind) broke('replaces_kind', index, 'kind');
					if (fingerprint(old.content) === fingerprint(claim.content)) {
						// Naming a record and replacing it with itself is an explicit "this still holds", so it
						// must count at least as much as leaving it standing silently. Without this, a summary
						// source that reaffirms a record outright moves nothing while one that says nothing
						// about it confirms it - the stronger signal worth less than the weaker one.
						reaffirmed.add(old.id);
						if (run.source.kind !== "summary" && mayReplace(old, incoming)) after.set(old.id, { ...old, sourceEntryId: run.source.id,
							updatedAt: run.source.createdAt, evidence: incoming, status: "provisional", revision: old.revision + 1 });
						annotate(old, claim); continue;
					}
					const next = this.claim(run.source, claim, "model");
					// Local extraction may already have added the replacement from this source.
					const existing = run.memories.find((m) => m.id !== old.id && m.kind === claim.kind && fingerprint(m.content) === fingerprint(claim.content));
					if ((!next && !existing) || (existing && !active(after.get(existing.id) ?? existing))) continue;
					if (existing && claims.some((c) => c.replaces === existing.id)) broke('cyclic_replaces', index, 'replaces');
					if (!mayReplace(old, incoming)) {
						// Quarantine only this source's weaker variant; preserve stronger evidence.
						const weaker = next ?? (existing?.sourceEntryId === run.source.id ? existing : undefined);
						if (weaker) {
							this.block(weaker, run.source.id);
							after.set(weaker.id, { ...weaker, status: "conflicted", revision: weaker.revision + (next ? 0 : 1) });
							for (const staged of after.values()) if (fingerprint(staged.content) === fingerprint(weaker.content))
								after.set(staged.id, { ...staged, status: "conflicted" });
						}
						weakerConflicts++; continue;
					}
					this.block(old, run.source.id);
					after.set(old.id, { ...old, status: "forgotten", updatedAt: run.source.createdAt, revision: old.revision + 1 });
					if (next) stage(next);
					else if (existing && existing.layer !== "pinned" && mayReplace(existing, incoming)
						&& Date.parse(existing.updatedAt) <= Date.parse(run.source.createdAt)) {
						after.set(existing.id, { ...existing, sourceEntryId: run.source.id, updatedAt: run.source.createdAt,
							evidence: incoming, feedback: undefined, status: "provisional", revision: existing.revision + 1 });
						annotate(existing, claim);
					} else annotate(existing, claim);
				} else {
					const next = this.claim(run.source, claim, "model");
					if (next) stage(next);
					else annotate(run.memories.find((m) => m.kind === claim.kind && fingerprint(m.content) === fingerprint(claim.content)), claim);
				}
			}
			// Shown, measured to be mentioned by this source, and either left standing or explicitly
			// replaced by identical content: the model saw the record beside fresh evidence about the same
			// terms and did not contradict it. That is "not disputed by evidence that mentioned it", not
			// "verified" - enough to keep a record out of dormancy, never enough to raise its authority.
			//
			// The model producing content the store already holds is deliberately NOT a signal. The whole
			// content of every candidate is in front of it and the prompt asks for aliases on unchanged
			// records, so re-emitting one is the cheapest move available, not independent re-derivation.
			// Progress sources are excluded because their candidates are host-nominated targets, not
			// records measured to be mentioned. Today that guard is subsumed by the project_state rule
			// below - `selectCandidates` only ever nominates project_state for a progress source - so it
			// has no test of its own. It stays because the two rules answer different questions, and
			// dropping it would make project_state's rule silently load-bearing for both.
			// project_state is excluded for the same reason - states go stale silently, and silence is far
			// too weak to keep resetting the one seven-day safety cap that actually does work.
			if (run.source.kind !== "progress") for (const shown of run.candidates)
				if (shown.kind !== "project_state" && (!targets.has(shown.id) || reaffirmed.has(shown.id))) confirmed.add(shown.id);
			const event = this.record("model", `${model}: ${run.source.id}${weakerConflicts ? `; weaker replacements withheld=${weakerConflicts}` : ""}`, [...after.values()], run.source.scope);
			// After `record`, so a record this batch also changed is confirmed on top of that change.
			this.reinforce(confirmed, run.source.createdAt);
			this.db.prepare("UPDATE sources SET state='done',lease=0,failures=0,output_failures=0,retry_at=0,failed_at=0,last_error='',diagnostic=? WHERE id=?")
				.run(JSON.stringify(diagnostic), run.source.id);
			finishCall(this.db, run.source.id, run.attempt, 'done', Date.now(), '', diagnostic);
			return event;
		});
	}
	failEvolution(run: Pick<EvolutionRun, "source" | "attempt">, code: FailureCode = "unknown", now = Date.now(), diagnostic: Diagnostic = {}, jitter = false): void {
		if (!FAILURE_CODES.includes(code)) throw new Error("Invalid failure code");
		if (!validDiagnostic(diagnostic)) throw new Error('Invalid memory diagnostics');
		this.transaction(() => {
			const job = this.db.prepare(`SELECT failures,output_failures,diagnostic,${pausedSQL(this.policy)} AS paused FROM sources WHERE id=? AND attempt=? AND state='running'`).get(run.source.id, run.attempt);
			finishCall(this.db, run.source.id, run.attempt, !job || code === 'cancelled' ? 'cancelled' : 'failed', now, code, diagnostic);
			if (!job) return; // A newer owner or manual suppression wins.
			if (code === "cancelled") {
				// Shutdown/reload cannot exhaust or silently reset either failure budget.
				this.db.prepare("UPDATE sources SET state=?,lease=0,retry_at=? WHERE id=?")
					.run(job.paused ? "failed" : "pending", now, run.source.id);
				return;
			}
			const failures = Number(job.failures) + 1;
			const outputFailures = Number(job.output_failures) + (['invalid_output', 'output_limit'].includes(code) ? 1 : 0);
			const paused = failures >= MAX_FAILURES || outputFailures >= MAX_OUTPUT_FAILURES || ['write_rejected', 'unavailable', 'safety'].includes(code);
			// Report one outcome, never a blend: a new reason must not inherit an older attempt's field path.
			// An interrupted run supplies none, so the previous explanation is kept rather than blanked.
			const details = Object.keys(diagnostic).length ? diagnostic : parseDiagnostic(job.diagnostic);
			let due = paused ? 0 : ['auth','quota','rate_limit','context_limit','request'].includes(code) ? now : retryAt(failures, now);
			if (jitter && due > now) due += Math.floor((due - now) * Math.random() * 0.2);
			this.db.prepare("UPDATE sources SET state='failed',lease=0,failures=?,output_failures=?,retry_at=?,failed_at=?,last_error=?,diagnostic=? WHERE id=?")
				.run(failures, outputFailures, due, now, code, JSON.stringify(details), run.source.id);
		});
	}
	/** Crash recovery is local; an expired lease consumes a failure budget, not infinite restarts. */
	recoverExpired(now = Date.now()): void {
		for (const row of this.db.prepare("SELECT id,data,attempt FROM sources WHERE state='running' AND lease<=?").all(now)) {
			this.failEvolution({ source: parseSource(row.data), attempt: Number(row.attempt) }, "interrupted", now);
		}
	}
	pausedJobs(): number {
		return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE state IN ('pending','failed') AND ${pausedSQL(this.policy)}`).get()!.n);
	}
	takeNotice(identity: string, now = Date.now()): boolean {
		return this.transaction(() => takeNotice(this.db, identity, now));
	}
	jobNoticeKey(id: string): string {
		const row = this.db.prepare(`SELECT last_error,diagnostic,${pausedSQL(this.policy)} AS paused FROM sources WHERE id=?`).get(id);
		return JSON.stringify([id, row?.last_error, row ? parseDiagnostic(row.diagnostic).reason : '', !!row?.paused]);
	}
	pausedNoticeKey(): string {
		return JSON.stringify(this.db.prepare(`SELECT id,last_error FROM sources WHERE state IN ('pending','failed') AND ${pausedSQL(this.policy)} ORDER BY id`).all());
	}
	/** Reports what a real claim would find, so status cannot disagree with the path that spends money. */
	budgetStatus(model: string, now = Date.now(), call?: CallOptions): string {
		// Unconditional, exactly as beginEvolution does it: a missing model yields null (unknown), not free.
		const reserve = estimatedCost(0, call);
		const until = budgetUntil(this.db, modelLabel(model), now, this.policy, reserve);
		if (until <= now) return 'Shared model budget: available.';
		if (Number.isFinite(until)) return `Shared model budget: waiting until ${new Date(until).toISOString()} (manual evolve does not bypass shared ceilings).`;
		return reserve === null
			? `Shared model budget: blocked. dailyEstimatedUsd is set but ${modelLabel(model)} has no catalog pricing, so the ceiling cannot be enforced and no call is made. Remove dailyEstimatedUsd from recovery.json, or use a model with known pricing.`
			: 'Shared model budget: blocked. One estimated call already exceeds dailyEstimatedUsd, so waiting cannot help. Raise the ceiling in recovery.json.';
	}
	routeAvailable(model: string, provider: string, now = Date.now()): boolean {
		return routeUntil(this.db, modelLabel(model), modelLabel(provider), now) <= now;
	}
	routingInfo(id: string): { models: string[]; calls: number; outputFailures: number; error: string; model?: string } {
		const row = this.db.prepare('SELECT call_models,calls,output_failures,last_error,diagnostic FROM sources WHERE id=?').get(id);
		const last = this.db.prepare('SELECT model FROM model_calls WHERE source_id=? ORDER BY attempt DESC LIMIT 1').get(id);
		return row ? { models: parseModels(row.call_models), calls: Number(row.calls), outputFailures: Number(row.output_failures), error: String(row.last_error), model: last ? String(last.model) : parseDiagnostic(row.diagnostic).model }
			: { models: [], calls: 0, outputFailures: 0, error: '' };
	}
	checked(id: string): void { this.transaction(() => { this.db.prepare('UPDATE sources SET last_checked=? WHERE id=?').run(Date.now(), id); }); }
	routingStatus(now = Date.now()): string {
		const totals = this.db.prepare('SELECT COUNT(*) AS n,SUM(COALESCE(charged_usd,reserved_usd,0)) AS usd,SUM(charged_usd IS NULL AND reserved_usd IS NULL) AS unknown FROM model_calls WHERE at>?').get(now - 86_400_000)!;
		const calls = this.db.prepare('SELECT COUNT(*) AS n FROM model_calls WHERE at>?').get(now - 3_600_000)!;
		const routes = this.db.prepare('SELECT id,until,code FROM route_health WHERE until>? ORDER BY until LIMIT 10').all(now);
		const recent = this.db.prepare('SELECT model,outcome,code FROM model_calls ORDER BY at DESC,rowid DESC LIMIT 5').all();
		return [`Routing: default follows Pi; cross-provider fallback=${this.policy.crossProviderFallback}; models/source<=${this.policy.sourceModels}; calls/source<=${this.policy.sourceCalls}; time/source<=${this.policy.sourceTimeMs}ms`,
			`Shared calls/hour=${calls.n}/${this.policy.callsPerHour}; last24h=${totals.n}; catalog-estimated/reported USD=${Number(totals.usd ?? 0).toFixed(4)}; unknown-cost calls=${totals.unknown ?? 0}; estimated daily ceiling=${this.policy.dailyEstimatedUsd ?? 'disabled'}`,
			...routes.map(r => `${modelLabel(String(r.id))}: ${r.code}; availableAfter=${new Date(Number(r.until)).toISOString()}`),
			...recent.map(r => `Attempt ${modelLabel(String(r.model))}: ${r.outcome}${r.code ? `/${r.code}` : ''}`)].join('\n');
	}
	/** Bounded diagnostics: only fixed codes/times/counts, never provider bodies or source text. */
	recoveryStatus(): string {
		const count = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE state='failed' OR (state='pending' AND ${pausedSQL(this.policy)})`).get()!.n);
		const rows = this.db.prepare(`SELECT id,attempt,failures,output_failures,calls,call_ms,retry_at,failed_at,last_error,diagnostic,${pausedSQL(this.policy)} AS paused FROM sources WHERE state='failed' OR (state='pending' AND ${pausedSQL(this.policy)}) ORDER BY failed_at DESC,rowid DESC LIMIT 5`).all();
		const paused = this.pausedJobs();
		const details = rows.map((r) => {
			const code = FAILURE_CODES.includes(r.last_error as FailureCode) ? r.last_error : "unknown";
			const failedAt = r.failed_at ? new Date(Number(r.failed_at)).toISOString() : "unknown (legacy)";
			const next = r.paused ? "paused; inspect diagnostics, /memory evolve <source-id> for one extra attempt"
				: `nextRetry=${r.retry_at ? new Date(Number(r.retry_at)).toISOString() : "due now"}`;
			return `${clipBytes(redact(String(r.id)), 160)}: ${code}; attempts=${r.attempt}; failures=${r.failures}/${MAX_FAILURES}; outputFailures=${r.output_failures}/${MAX_OUTPUT_FAILURES}; calls=${r.calls}/${this.policy.sourceCalls}; requestMs=${r.call_ms}/${this.policy.sourceTimeMs}; failedAt=${failedAt}; ${next}\n  diagnostics=${JSON.stringify(parseDiagnostic(r.diagnostic))}`;
		});
		const deferred = this.db.prepare("SELECT COUNT(*) AS n,MIN(retry_at) AS next FROM sources WHERE state='pending' AND retry_at>?").get(Date.now())!;
		return [`Automatic recovery: retrying=${count - paused}, paused=${paused} (failure limit ${MAX_FAILURES}; output limit ${MAX_OUTPUT_FAILURES}; non-retryable errors pause immediately)`,
			...(Number(deferred.n) ? [`Source-backoff waiting=${deferred.n}; nextEligible=${new Date(Number(deferred.next)).toISOString()}`] : []), ...details,
			...(count > 5 ? [`${count - 5} more failed sources.`] : [])].join("\n");
	}
	/** Explicit exact-ID user feedback only. No inferred usage or self-reinforcement.
	 * Receipts survive undo/restart so replay cannot reapply an old verdict. */
	feedback(id: string, verdict: FeedbackVerdict, sourceId = `manual:${randomUUID()}`, at = new Date().toISOString()): string | undefined {
		if (!FEEDBACK_VERDICTS.has(verdict)) throw new Error("Invalid feedback verdict");
		const signal = { verdict, sourceId, at };
		const key = verdict === "useful" || verdict === "unhelpful" ? "utility" : "accuracy";
		if (!validFeedback({ [key]: signal })) throw new Error("Invalid feedback source");
		return this.transaction(() => {
			const old = this.get(id);
			if (!old) throw new Error("Unknown memory id");
			if (this.db.prepare("SELECT 1 FROM feedback_receipts WHERE source_id=? AND memory_id=?").get(sourceId, id)) return undefined;
			if (!active(old)) throw new Error("Resolve/correct the memory first");
			const last = this.db.prepare(`SELECT MAX(at) AS at FROM feedback_receipts WHERE memory_id=? AND verdict IN (${key === "utility" ? "'useful','unhelpful'" : "'accurate','incorrect'"})`).get(id);
			this.db.prepare("INSERT INTO feedback_receipts VALUES (?,?,?,?)").run(sourceId, id, verdict, Date.parse(at));
			const previous = old.feedback?.[key];
			if (Date.parse(at) < Date.parse(old.updatedAt) || (last?.at != null && Number(last.at) > Date.parse(at))
				|| (previous && (Date.parse(previous.at) > Date.parse(at) || previous.verdict === verdict))) return undefined;
			const next: DurableMemory = { ...old, feedback: { ...old.feedback, [key]: signal }, revision: old.revision + 1 };
			const changes = [next];
			if (verdict === "incorrect") {
				this.block(old); next.status = "conflicted";
				for (const duplicate of this.readMemories(old.scope)) if (duplicate.id !== id && active(duplicate)
					&& fingerprint(duplicate.content) === fingerprint(old.content)) {
					this.block(duplicate);
					changes.push({ ...duplicate, status: "conflicted", feedback: { ...duplicate.feedback, accuracy: signal }, revision: duplicate.revision + 1 });
				}
			}
			return this.record("manual", `Feedback ${verdict}: ${sourceId}`, changes, old.scope);
		});
	}
	act(id: string, type: MemoryAction, value?: string): string {
		return this.transaction(() => {
			const old = this.get(id);
			if (!old) throw new Error("Unknown memory id");
			const at = new Date().toISOString();
			let next = { ...old, updatedAt: ["pin", "unpin", "adopt", "conflict", "resolve"].includes(type) ? old.updatedAt : at, revision: old.revision + 1 };
			const changes: DurableMemory[] = [];
			if (type === "forget" || type === "correct") {
				this.block(old);
				next.suppressedHashes = [...new Set([...(old.suppressedHashes ?? []), fingerprint(old.content)])];
				for (const duplicate of this.readMemories(old.scope)) {
					if (duplicate.id !== id && duplicate.scope === old.scope && fingerprint(duplicate.content) === fingerprint(old.content))
						changes.push({ ...duplicate, status: "forgotten", updatedAt: at, revision: duplicate.revision + 1 });
				}
			}
			switch (type) {
				case "correct": {
					const content = redact(value ?? "").trim();
					if (content.length < MIN_CLAIM_CHARS || content.length > MAX_CLAIM_CHARS || content.includes("[REDACTED")) throw new Error(`Correction must be ${MIN_CLAIM_CHARS}–${MAX_CLAIM_CHARS} characters without credentials`);
					next = { ...next, content, status: "confirmed", searchTerms: undefined, feedback: undefined,
						evidence: { basis: "manual_correction", method: "manual", sourceId: `manual:${randomUUID()}`, at } }; break;
				}
				case "forget": next.status = "forgotten"; break;
				case "pin": if (!active(old)) throw new Error("Resolve/correct the memory first"); next.layer = "pinned"; break;
				case "unpin": next.layer = "durable"; break;
				case "resolve":
					if (old.status !== "conflicted") throw new Error("Memory is not conflicted");
					next.status = "confirmed"; next.updatedAt = old.updatedAt;
					next.feedback = { ...old.feedback, accuracy: { verdict: "accurate", at, sourceId: `manual:${randomUUID()}` } }; break;
				case "conflict": {
					const other = this.get(value ?? "");
					if (!other || other.id === id || other.scope !== old.scope || !active(other) || !active(old)) throw new Error("Conflict needs two active memories in the same scope");
					this.block(old); this.block(other);
					next.status = "conflicted";
					changes.push({ ...other, status: "conflicted", revision: other.revision + 1 }); break;
				}
				case "adopt":
					if (old.scope !== "legacy" || !value) throw new Error("Only unscoped legacy memories can be adopted");
					next.scope = resolve(value); break;
				default: throw new Error("Unknown memory action");
			}
			return this.record("manual", type, [...changes, next], next.scope);
		});
	}
	history(scope?: string): Event[] {
		return this.db.prepare(scope ? "SELECT id,scope,data FROM events WHERE scope=? ORDER BY rowid DESC LIMIT 10" : "SELECT id,scope,data FROM events ORDER BY rowid DESC LIMIT 10")
			.all(...(scope ? [scope] : [])).map((row) => parseEvent(row.data, row.id, row.scope));
	}
	undo(id: string): string {
		return this.transaction(() => {
			const row = this.db.prepare("SELECT scope,data FROM events WHERE id=?").get(id);
			if (!row) throw new Error("Unknown event id");
			const event = parseEvent(row.data, id, row.scope);
			if (!event.after.length) throw new Error("Event has no memory changes");
			// `reinforcedAt` is deliberately outside this comparison. Confirmation writes no event, so an
			// event's snapshot can never carry a stamp written after it; comparing it would make every
			// confirmed record permanently un-undoable. It is also not part of what an undo restores -
			// there is nothing to undo about having been mentioned - so the current stamp is carried
			// forward onto the restored record rather than reverted with it.
			const settled = (memory: DurableMemory | undefined) => memory && JSON.stringify({ ...memory, reinforcedAt: undefined });
			const restored = event.after.map((after, i) => {
				const current = this.get(after.id);
				if (settled(current) !== settled(after)) throw new Error("Memory changed since this event; undo refused");
				this.block(after);
				return { ...(event.before[i] ?? { ...after, status: "forgotten" as const }), revision: after.revision + 1,
					...(current?.reinforcedAt ? { reinforcedAt: current.reinforcedAt } : {}),
					suppressedHashes: [...new Set([...(event.before[i]?.suppressedHashes ?? []), ...(after.suppressedHashes ?? []), fingerprint(after.content)])] };
			});
			return this.record("manual", `Undo ${id}`, restored, event.scope);
		});
	}
	/** Persistent transaction outcomes, not a claim that every completed job learned something. */
	processingStatus(): string {
		const rows = this.db.prepare("SELECT id,scope,data FROM events WHERE json_extract(data,'$.actor')='model' ORDER BY rowid DESC LIMIT 5").all();
		const outcomes = rows.map(row => {
			const event = parseEvent(row.data, row.id, row.scope);
			return `${clipBytes(redact(event.reason), 200)}: changedRecords=${event.after.length}${event.after.length ? '' : ' (no memory changes)'}`;
		});
		return ['Processing outcomes: done means processed/retired, not necessarily learned.', ...outcomes,
			...(rows.length ? [] : ['No model transactions yet.']), 'Use /memory learning for the last capture/nomination decision.'].join('\n');
	}
	status(): string {
		if (this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value !== SCHEMA_VERSION) throw new Error("Invalid memory schema marker");
		const health = this.db.prepare("PRAGMA quick_check").get();
		if (health?.quick_check !== "ok") throw new Error("Memory database integrity check failed");
		for (const row of this.db.prepare("SELECT id,data,state,attempt,lease,failures,output_failures,retry_at,failed_at,last_error,diagnostic,calls,call_ms,call_models,last_checked,corrections FROM sources").iterate()) {
			const source = parseSource(row.data);
			if (source.id !== row.id || !["pending", "running", "done", "failed"].includes(String(row.state))
				|| ![row.attempt, row.lease, row.failures, row.output_failures, row.retry_at, row.failed_at, row.calls, row.call_ms, row.last_checked, row.corrections].every((v) => Number.isSafeInteger(v) && Number(v) >= 0)
				|| (row.last_error !== "" && !FAILURE_CODES.includes(row.last_error as FailureCode))) throw new Error("Invalid source job");
			parseDiagnostic(row.diagnostic); parseModels(row.call_models);
		}
		for (const row of this.db.prepare("SELECT id,scope,data FROM events").iterate()) parseEvent(row.data, row.id, row.scope);
		for (const row of this.db.prepare("SELECT source_id,memory_id,verdict,at FROM feedback_receipts").iterate()) {
			if (typeof row.source_id !== "string" || !row.source_id || typeof row.memory_id !== "string" || !row.memory_id
				|| !FEEDBACK_VERDICTS.has(row.verdict as FeedbackVerdict) || !Number.isSafeInteger(row.at)) throw new Error("Invalid feedback receipt");
		}
		const jobs = this.db.prepare("SELECT state,COUNT(*) AS n FROM sources GROUP BY state").all();
		return `${this.readMemories().length} memories; ${jobs.map((j) => `${j.state}=${j.n}`).join(", ") || "no sources"}; SQLite ok (schema ${SCHEMA_VERSION})\nState directory: ${redact(this.stateDir)}\n${this.recoveryStatus()}\n${this.routingStatus()}\n${this.legacyStatus()}\n${this.processingStatus()}`;
	}
}

function parseModels(value: unknown): string[] {
	const models: unknown = JSON.parse(String(value));
	if (!Array.isArray(models) || !models.every(m => typeof m === 'string' && modelLabel(m) === m)) throw new Error('Invalid source models');
	return models;
}
function isSource(value: unknown): value is Source {
	if (!value || typeof value !== "object") return false;
	const s = value as Source;
	return typeof s.id === "string" && !!s.id.trim() && typeof s.scope === "string" && !!s.scope.trim()
		&& ["summary", "user", "progress"].includes(s.kind) && typeof s.content === "string"
		&& (s.kind === "progress" ? (Array.isArray(s.targets) && s.targets.length > 0 && s.targets.length <= 8
			&& s.targets.every((id) => typeof id === "string" && !!id.trim()) && new Set(s.targets).size === s.targets.length) : s.targets === undefined)
		&& typeof s.createdAt === "string" && Number.isFinite(Date.parse(s.createdAt));
}
function parseSource(data: unknown): Source {
	const source: unknown = JSON.parse(String(data));
	if (!isSource(source)) throw new Error("Invalid source record");
	return source;
}
function parseEvent(data: unknown, id: unknown, scope: unknown): Event {
	const event = JSON.parse(String(data)) as Event | null;
	if (!event || typeof event.id !== "string" || !event.id || typeof event.scope !== "string" || !event.scope
		|| event.id !== id || event.scope !== scope
		|| !["local", "manual", "model", "migration"].includes(event.actor) || typeof event.reason !== "string"
		|| typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))
		|| !Array.isArray(event.before) || !Array.isArray(event.after) || event.before.length !== event.after.length
		|| !event.after.every((after, i) => isMemory(after) && (event.before[i] === null
			|| (isMemory(event.before[i]) && event.before[i]!.id === after.id)))
		|| new Set(event.after.map((m) => m.id)).size !== event.after.length) throw new Error("Invalid history record");
	return event;
}
function isMemory(value: unknown): value is DurableMemory {
	if (!value || typeof value !== "object") return false;
	const m = value as DurableMemory;
	return typeof m.id === "string" && !!m.id && MEMORY_KINDS.has(m.kind) && typeof m.content === "string" && !!m.content.trim()
		&& typeof m.scope === "string" && !!m.scope && typeof m.sourceEntryId === "string" && !!m.sourceEntryId
		&& validSearchTerms(m.searchTerms) && validEvidence(m.evidence) && validFeedback(m.feedback)
		&& (m.evidence?.basis !== "tool_observation" || m.kind === "project_state")
		&& (m.suppressedHashes === undefined || (Array.isArray(m.suppressedHashes) && m.suppressedHashes.every((h) => typeof h === "string" && /^[a-f0-9]{24}$/u.test(h))))
		&& typeof m.createdAt === "string" && typeof m.updatedAt === "string"
		&& Number.isFinite(Date.parse(m.createdAt)) && Number.isFinite(Date.parse(m.updatedAt))
		&& (m.reinforcedAt === undefined || (typeof m.reinforcedAt === "string" && Number.isFinite(Date.parse(m.reinforcedAt))))
		&& Number.isInteger(m.revision) && m.revision > 0 && ["durable", "pinned"].includes(m.layer)
		&& ["provisional", "confirmed", "forgotten", "conflicted"].includes(m.status);
}
