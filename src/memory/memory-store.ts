import { Database } from "./sqlite.ts";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { extractStructuredMemories, type Claim } from "./extractor.ts";
import { loadLegacyMemories } from "./legacy.ts";
import { clipBytes, fingerprint, redact } from "./privacy.ts";
import { validSearchTerms } from "./search.ts";
import { EVOLUTION_TIMEOUT_MS, LEASE_GRACE_MS, MAX_FAILURES, FAILURE_CODES, EvolutionError, retryAt, type FailureCode } from "./recovery.ts";

export type RetryMode = boolean | "auto";
// Rechecked atomically when claiming: selection alone never grants model-call authority.
const automaticEligibility = "((state='pending' AND retry_at<=?) OR (state='failed' AND failures<" + MAX_FAILURES + " AND retry_at<=?))";

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
	memories: DurableMemory[];
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
	constructor(stateDir: string) {
		this.stateDir = stateDir;
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const file = join(stateDir, "memory.sqlite");
		try { const fd = openSync(file, "wx", 0o600); closeSync(fd); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Memory database must be a regular file");
		chmodSync(file, 0o600);
		this.db = new Database(file);
		try {
			this.db.exec("PRAGMA busy_timeout=5000");
			if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get()) {
				const schema = this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get();
				if (schema && !["2", "3", "4"].includes(String(schema.value))) throw new Error("Unsupported memory database version");
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
				if (schema && !["2", "3", "4"].includes(String(schema.value))) throw new Error("Unsupported memory database version");
				if (schema?.value !== "4") {
					const columns = new Set(this.db.prepare("PRAGMA table_info(sources)").all().map((r) => r.name));
					for (const [name, type] of [["failures", "INTEGER NOT NULL DEFAULT 0"], ["retry_at", "INTEGER NOT NULL DEFAULT 0"],
						["failed_at", "INTEGER NOT NULL DEFAULT 0"], ["last_error", "TEXT NOT NULL DEFAULT ''"]]) {
						if (!columns.has(name)) this.db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`);
					}
					// Old errors have no known cause/time. Make them eligible without inventing either.
					this.db.exec("UPDATE sources SET failures=MIN(MAX(attempt,1),5),last_error='unknown' WHERE state='failed' AND failures=0");
				}
				this.db.exec("CREATE INDEX IF NOT EXISTS sources_recovery ON sources(state,retry_at); CREATE INDEX IF NOT EXISTS sources_running_lease ON sources(lease) WHERE state='running'");
				if (!schema) {
					const legacy = loadLegacyMemories(stateDir);
					if (legacy.length) this.record("migration", "Import legacy JSONL; originals unchanged", legacy, "legacy");
					this.db.prepare("INSERT INTO metadata VALUES ('schema','4')").run();
				} else if (schema.value !== "4") {
					this.db.prepare("UPDATE metadata SET value='4' WHERE key='schema'").run();
				}
			});
		} catch (error) { this.db.close(); throw error; }
	}
	close(): void { this.db.close(); }
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
		return cached.memories.map((m) => ({ ...m, ...(m.suppressedHashes ? { suppressedHashes: [...m.suppressedHashes] } : {}),
			...(m.searchTerms ? { searchTerms: [...m.searchTerms] } : {}) }));
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
		const pending = this.db.prepare("SELECT id,data FROM sources WHERE json_extract(data,'$.scope')=? AND state!='done'").all(memory.scope);
		for (const row of pending) {
			if (row.id === keepSource) continue;
			const source = parseSource(row.data);
			if (source.id === memory.sourceEntryId || source.targets?.includes(memory.id) || source.content === body || source.content.includes(memory.content)
				|| extractStructuredMemories(source.content, Infinity).some((claim) => fingerprint(claim.content) === hash))
				this.db.prepare("UPDATE sources SET state='done',lease=0 WHERE id=?").run(source.id);
		}
	}
	private claim(source: Source, item: Claim): DurableMemory | undefined {
		const content = redact(item.content).trim();
		if (!validSearchTerms(item.searchTerms) || !MEMORY_KINDS.has(item.kind) || content.length < 4 || content.length > 480 || content.includes("[REDACTED")) throw new Error("Invalid or sensitive claim");
		const id = fingerprint(JSON.stringify([source.scope, item.kind, content]));
		if (this.get(id) || this.db.prepare("SELECT 1 FROM blocked WHERE scope=? AND hash=?").get(source.scope, fingerprint(content))) return undefined;
		// Also respect forgotten legacy records whose ids predate content-addressing.
		if (this.db.prepare("SELECT 1 FROM memories WHERE scope=? AND hash=?").get(source.scope, fingerprint(content))) return undefined;
		return { id, kind: item.kind, content, scope: source.scope, sourceEntryId: source.id,
			createdAt: source.createdAt, updatedAt: source.createdAt, revision: 1, layer: "durable", status: "provisional",
			...(item.searchTerms ? { searchTerms: [...new Set(item.searchTerms)] } : {}) };
	}
	/** Persist raw evidence + bounded local claims once, atomically. Raw sources are never recalled. */
	capture(input: Source): boolean {
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
			${retry === "auto" ? automaticEligibility : `(state='pending' OR (state='running' AND lease<=?) ${retry ? "OR state='failed'" : ""})`}
			ORDER BY ${retry === "auto" ? "retry_at ASC, rowid ASC" : "rowid DESC"} LIMIT 1`)
			.get(...(scope === undefined ? [] : [scope]), now, ...(retry === "auto" ? [now] : []));
		return row ? String(row.id) : undefined;
	}
	beginEvolution(id: string, retry: RetryMode = false, timeoutMs = EVOLUTION_TIMEOUT_MS, now = Date.now()): EvolutionRun | undefined {
		return this.transaction(() => {
			const changed = this.db.prepare(`UPDATE sources SET state='running', attempt=attempt+1, lease=? WHERE id=? AND
				${retry === "auto" ? automaticEligibility : `(state='pending' OR (state='running' AND lease<=?) ${retry ? "OR state='failed'" : ""})`}`)
				.run(now + timeoutMs + LEASE_GRACE_MS, id, now, ...(retry === "auto" ? [now] : []));
			if (!changed.changes) return undefined;
			const row = this.db.prepare("SELECT data,attempt FROM sources WHERE id=?").get(id)!;
			const source = parseSource(row.data);
			if (source.id !== id) throw new Error("Invalid source identity");
			const memories = this.readMemories(source.scope).filter((m) => m.scope === source.scope && active(m)
				&& (source.kind !== "progress" || (m.kind === "project_state" && source.targets!.includes(m.id))))
				.sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0, 32);
			return { source, attempt: Number(row.attempt), generation: this.generation(source.scope), memories };
		});
	}
	finishEvolution(run: EvolutionRun, claims: Claim[], model: string): string {
		return this.transaction(() => {
			const job = this.db.prepare("SELECT state,attempt FROM sources WHERE id=?").get(run.source.id);
			if (job?.state !== "running" || job.attempt !== run.attempt || this.generation(run.source.scope) !== run.generation) throw new EvolutionError("stale");
			const after = new Map<string, DurableMemory>();
			const targets = new Set<string>();
			const stage = (memory: DurableMemory) => {
				if (![...after.values()].some((m) => active(m) && fingerprint(m.content) === fingerprint(memory.content))) after.set(memory.id, memory);
			};
			const annotate = (memory: DurableMemory | undefined, claim: Claim) => {
				if (!memory || !claim.searchTerms || memory.layer === "pinned") return;
				const current = after.get(memory.id) ?? memory;
				const searchTerms = [...new Set(claim.searchTerms)];
				if (active(current) && JSON.stringify(current.searchTerms) !== JSON.stringify(searchTerms))
					after.set(memory.id, { ...current, searchTerms, revision: memory.revision + 1 });
			};
			for (const claim of claims) {
				if (!validSearchTerms(claim.searchTerms)) throw new Error("Invalid search terms");
				if (run.source.kind === "progress" && (claim.kind !== "project_state" || !claim.replaces || !run.source.targets!.includes(claim.replaces)))
					throw new Error("Progress observations may only update nominated project-state records");
				if (claim.replaces) {
					const old = run.memories.find((m) => m.id === claim.replaces);
					if (!old || old.scope !== run.source.scope || targets.has(old.id) || old.layer === "pinned"
						|| (run.source.kind === "progress" && old.kind !== "project_state")
						|| Date.parse(old.updatedAt) > Date.parse(run.source.createdAt)) throw new Error("Invalid replacement target");
					targets.add(old.id);
					if (fingerprint(old.content) === fingerprint(claim.content)) {
						if (run.source.kind === "progress") after.set(old.id, { ...old, sourceEntryId: run.source.id,
							updatedAt: run.source.createdAt, status: "provisional", revision: old.revision + 1 });
						annotate(old, claim); continue;
					}
					const next = this.claim(run.source, claim);
					// Local extraction may already have added the replacement from this source.
					const existing = run.memories.find((m) => m.id !== old.id && m.kind === claim.kind && fingerprint(m.content) === fingerprint(claim.content));
					if (!next && !existing) continue;
					if (existing && claims.some((c) => c.replaces === existing.id)) throw new Error("Cyclic memory replacement");
					this.block(old, run.source.id);
					after.set(old.id, { ...old, status: "forgotten", updatedAt: run.source.createdAt, revision: old.revision + 1 });
					if (next) stage(next); else annotate(existing, claim);
				} else {
					const next = this.claim(run.source, claim);
					if (next) stage(next);
					else annotate(run.memories.find((m) => m.kind === claim.kind && fingerprint(m.content) === fingerprint(claim.content)), claim);
				}
			}
			const event = this.record("model", `${model}: ${run.source.id}`, [...after.values()], run.source.scope);
			this.db.prepare("UPDATE sources SET state='done',lease=0,failures=0,retry_at=0,failed_at=0,last_error='' WHERE id=?").run(run.source.id);
			return event;
		});
	}
	failEvolution(run: Pick<EvolutionRun, "source" | "attempt">, code: FailureCode = "unknown", now = Date.now()): void {
		if (!FAILURE_CODES.includes(code)) throw new Error("Invalid failure code");
		this.transaction(() => {
			const job = this.db.prepare("SELECT failures FROM sources WHERE id=? AND attempt=? AND state='running'").get(run.source.id, run.attempt);
			if (!job) return; // A newer owner or manual suppression wins.
			if (code === "cancelled") {
				// Shutdown/reload is not a failed model response and must not exhaust retry budgets.
				this.db.prepare("UPDATE sources SET state=?,lease=0,retry_at=? WHERE id=?")
					.run(Number(job.failures) >= MAX_FAILURES ? "failed" : "pending", now, run.source.id);
				return;
			}
			const failures = Number(job.failures) + 1;
			this.db.prepare("UPDATE sources SET state='failed',lease=0,failures=?,retry_at=?,failed_at=?,last_error=? WHERE id=?")
				.run(failures, retryAt(failures, now), now, code, run.source.id);
		});
	}
	/** Crash recovery is local; an expired lease consumes a failure budget, not infinite restarts. */
	recoverExpired(now = Date.now()): void {
		for (const row of this.db.prepare("SELECT id,data,attempt FROM sources WHERE state='running' AND lease<=?").all(now)) {
			this.failEvolution({ source: parseSource(row.data), attempt: Number(row.attempt) }, "interrupted", now);
		}
	}
	pausedJobs(): number {
		return Number(this.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE state='failed' AND failures>=?").get(MAX_FAILURES)!.n);
	}
	/** Bounded diagnostics: only fixed codes/times/counts, never provider bodies or source text. */
	recoveryStatus(): string {
		const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE state='failed'").get()!.n);
		const rows = this.db.prepare("SELECT id,attempt,failures,retry_at,failed_at,last_error FROM sources WHERE state='failed' ORDER BY failed_at DESC,rowid DESC LIMIT 5").all();
		const paused = this.pausedJobs();
		const details = rows.map((r) => {
			const code = FAILURE_CODES.includes(r.last_error as FailureCode) ? r.last_error : "unknown";
			const failedAt = r.failed_at ? new Date(Number(r.failed_at)).toISOString() : "unknown (legacy)";
			const next = Number(r.failures) >= MAX_FAILURES ? "paused; inspect model/auth or output, /memory evolve for one extra attempt"
				: `nextRetry=${r.retry_at ? new Date(Number(r.retry_at)).toISOString() : "due now"}`;
			return `${clipBytes(redact(String(r.id)), 160)}: ${code}; attempts=${r.attempt}; failures=${r.failures}/${MAX_FAILURES}; failedAt=${failedAt}; ${next}`;
		});
		return [`Automatic recovery: retrying=${count - paused}, paused=${paused} (failure limit ${MAX_FAILURES})`, ...details,
			...(count > 5 ? [`${count - 5} more failed sources.`] : [])].join("\n");
	}
	act(id: string, type: MemoryAction, value?: string): string {
		return this.transaction(() => {
			const old = this.get(id);
			if (!old) throw new Error("Unknown memory id");
			const at = new Date().toISOString();
			let next = { ...old, updatedAt: ["pin", "unpin", "adopt"].includes(type) ? old.updatedAt : at, revision: old.revision + 1 };
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
					if (content.length < 4 || content.length > 480 || content.includes("[REDACTED")) throw new Error("Correction must be 4–480 characters without credentials");
					next = { ...next, content, status: "confirmed", searchTerms: undefined }; break;
				}
				case "forget": next.status = "forgotten"; break;
				case "pin": if (!active(old)) throw new Error("Resolve/correct the memory first"); next.layer = "pinned"; break;
				case "unpin": next.layer = "durable"; break;
				case "resolve": if (old.status !== "conflicted") throw new Error("Memory is not conflicted"); next.status = "confirmed"; break;
				case "conflict": {
					const other = this.get(value ?? "");
					if (!other || other.id === id || other.scope !== old.scope || !active(other) || !active(old)) throw new Error("Conflict needs two active memories in the same scope");
					this.block(old); this.block(other);
					next.status = "conflicted";
					changes.push({ ...other, status: "conflicted", updatedAt: at, revision: other.revision + 1 }); break;
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
			const restored = event.after.map((after, i) => {
				if (JSON.stringify(this.get(after.id)) !== JSON.stringify(after)) throw new Error("Memory changed since this event; undo refused");
				this.block(after);
				return { ...(event.before[i] ?? { ...after, status: "forgotten" as const }), revision: after.revision + 1,
					suppressedHashes: [...new Set([...(event.before[i]?.suppressedHashes ?? []), ...(after.suppressedHashes ?? []), fingerprint(after.content)])] };
			});
			return this.record("manual", `Undo ${id}`, restored, event.scope);
		});
	}
	status(): string {
		if (this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value !== "4") throw new Error("Invalid memory schema marker");
		const health = this.db.prepare("PRAGMA quick_check").get();
		if (health?.quick_check !== "ok") throw new Error("Memory database integrity check failed");
		for (const row of this.db.prepare("SELECT id,data,state,attempt,lease,failures,retry_at,failed_at,last_error FROM sources").iterate()) {
			const source = parseSource(row.data);
			if (source.id !== row.id || !["pending", "running", "done", "failed"].includes(String(row.state))
				|| ![row.attempt, row.lease, row.failures, row.retry_at, row.failed_at].every((v) => Number.isSafeInteger(v) && Number(v) >= 0)
				|| (row.last_error !== "" && !FAILURE_CODES.includes(row.last_error as FailureCode))) throw new Error("Invalid source job");
		}
		for (const row of this.db.prepare("SELECT id,scope,data FROM events").iterate()) parseEvent(row.data, row.id, row.scope);
		const jobs = this.db.prepare("SELECT state,COUNT(*) AS n FROM sources GROUP BY state").all();
		return `${this.readMemories().length} memories; ${jobs.map((j) => `${j.state}=${j.n}`).join(", ") || "no sources"}; SQLite ok (schema 4)\n${this.recoveryStatus()}`;
	}
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
		&& validSearchTerms(m.searchTerms)
		&& (m.suppressedHashes === undefined || (Array.isArray(m.suppressedHashes) && m.suppressedHashes.every((h) => typeof h === "string" && /^[a-f0-9]{24}$/u.test(h))))
		&& typeof m.createdAt === "string" && typeof m.updatedAt === "string"
		&& Number.isFinite(Date.parse(m.createdAt)) && Number.isFinite(Date.parse(m.updatedAt))
		&& Number.isInteger(m.revision) && m.revision > 0 && ["durable", "pinned"].includes(m.layer)
		&& ["provisional", "confirmed", "forgotten", "conflicted"].includes(m.status);
}
