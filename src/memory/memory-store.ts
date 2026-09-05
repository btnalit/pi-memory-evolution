import { Database } from "./sqlite.ts";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { extractStructuredMemories, type Claim } from "./extractor.ts";
import { loadLegacyMemories } from "./legacy.ts";
import { clipBytes, fingerprint, redact } from "./privacy.ts";

export type MemoryKind = "fact" | "preference" | "decision" | "project_state";
export interface DurableMemory {
	id: string;
	kind: MemoryKind;
	content: string;
	scope: string;
	sourceEntryId: string;
	createdAt: string;
	updatedAt: string;
	revision: number;
	layer: "durable" | "pinned";
	status: "provisional" | "confirmed" | "forgotten" | "conflicted";
}
export interface Source {
	id: string;
	scope: string;
	kind: "summary" | "user";
	content: string;
	createdAt: string;
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
			this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
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
				if (schema && schema.value !== "2") throw new Error("Unsupported memory database version");
				if (!schema) {
					const legacy = loadLegacyMemories(stateDir);
					if (legacy.length) this.record("migration", "Import legacy JSONL; originals unchanged", legacy, "legacy");
					this.db.prepare("INSERT INTO metadata VALUES ('schema','2')").run();
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
			const rows = scope === undefined ? this.db.prepare("SELECT id,scope,data FROM memories").all()
				: this.db.prepare("SELECT id,scope,data FROM memories WHERE scope=? OR scope='*'").all(scope);
			const memories = rows.map((row) => {
				const memory: unknown = JSON.parse(String(row.data));
				if (!isMemory(memory) || memory.id !== row.id || memory.scope !== row.scope) throw new Error("Invalid memory record; recall stopped");
				return memory;
			});
			cached = { version, memories };
			this.cache.set(key, cached);
		}
		return cached.memories.map((m) => ({ ...m }));
	}
	private get(id: string): DurableMemory | undefined {
		const row = this.db.prepare("SELECT data FROM memories WHERE id=?").get(id);
		if (!row) return undefined;
		const data: unknown = JSON.parse(String(row.data));
		if (!isMemory(data) || data.id !== id) throw new Error("Invalid memory record");
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
		}
		this.db.prepare("INSERT INTO events VALUES (?,?,?)").run(event.id, scope, JSON.stringify(event));
		this.cache.clear();
		return event.id;
	}
	private block(memory: DurableMemory): void {
		this.db.prepare("INSERT OR IGNORE INTO blocked VALUES (?,?)").run(memory.scope, fingerprint(memory.content));
		// Do not later re-learn a manually suppressed fact from its pending raw source.
		this.db.prepare("UPDATE sources SET state='done',lease=0 WHERE id=?").run(memory.sourceEntryId);
	}
	private claim(source: Source, item: Claim): DurableMemory | undefined {
		const content = redact(item.content).trim();
		if (!MEMORY_KINDS.has(item.kind) || content.length < 4 || content.length > 480 || content.includes("[REDACTED")) throw new Error("Invalid or sensitive claim");
		const id = fingerprint(`${source.scope}:${item.kind}:${content}`);
		if (this.get(id) || this.db.prepare("SELECT 1 FROM blocked WHERE scope=? AND hash=?").get(source.scope, fingerprint(content))) return undefined;
		// Also respect forgotten legacy records whose ids predate content-addressing.
		if (this.db.prepare("SELECT 1 FROM memories WHERE scope=? AND hash=?").get(source.scope, fingerprint(content))) return undefined;
		return { id, kind: item.kind, content, scope: source.scope, sourceEntryId: source.id,
			createdAt: source.createdAt, updatedAt: source.createdAt, revision: 1, layer: "durable", status: "provisional" };
	}
	/** Persist raw evidence + bounded local claims once, atomically. Raw sources are never recalled. */
	capture(input: Source): boolean {
		if (!input.id || !input.scope || !["summary", "user"].includes(input.kind) || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("Invalid memory source");
		const source = { ...input, createdAt: new Date(input.createdAt).toISOString(), content: clipBytes(redact(input.content), 32_000) };
		return this.transaction(() => {
			if (this.db.prepare("SELECT 1 FROM sources WHERE id=?").get(source.id)) return false;
			this.db.prepare("INSERT INTO sources(id,data) VALUES (?,?)").run(source.id, JSON.stringify(source));
			const claims = source.kind === "summary" ? extractStructuredMemories(source.content) : [];
			const memories = claims.map((c) => this.claim(source, c)).filter((m): m is DurableMemory => !!m);
			this.record("local", `Capture ${source.id}`, memories, source.scope);
			return true;
		});
	}
	pending(scope: string, retry = false): string | undefined {
		const row = this.db.prepare(`SELECT id FROM sources WHERE json_extract(data,'$.scope')=? AND
			(state='pending' OR (state='running' AND lease<?) ${retry ? "OR state='failed'" : ""}) ORDER BY rowid DESC LIMIT 1`).get(scope, Date.now());
		return row ? String(row.id) : undefined;
	}
	beginEvolution(id: string, retry = false): EvolutionRun | undefined {
		return this.transaction(() => {
			const changed = this.db.prepare(`UPDATE sources SET state='running', attempt=attempt+1, lease=? WHERE id=? AND
				(state='pending' OR (state='running' AND lease<?) ${retry ? "OR state='failed'" : ""})`).run(Date.now() + 60_000, id, Date.now());
			if (!changed.changes) return undefined;
			const row = this.db.prepare("SELECT data,attempt FROM sources WHERE id=?").get(id)!;
			const source: Source = JSON.parse(String(row.data));
			const memories = this.readMemories(source.scope).filter((m) => m.scope === source.scope && active(m))
				.sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0, 32);
			return { source, attempt: Number(row.attempt), generation: this.generation(source.scope), memories };
		});
	}
	finishEvolution(run: EvolutionRun, claims: Claim[], model: string): string {
		return this.transaction(() => {
			const job = this.db.prepare("SELECT state,attempt FROM sources WHERE id=?").get(run.source.id);
			if (job?.state !== "running" || job.attempt !== run.attempt || this.generation(run.source.scope) !== run.generation) throw new Error("Memory changed during evolution; stale result discarded");
			const after = new Map<string, DurableMemory>();
			const targets = new Set<string>();
			for (const claim of claims) {
				if (claim.replaces) {
					const old = run.memories.find((m) => m.id === claim.replaces);
					if (!old || targets.has(old.id) || old.layer === "pinned" || Date.parse(old.updatedAt) > Date.parse(run.source.createdAt)) throw new Error("Invalid replacement target");
					targets.add(old.id);
					if (fingerprint(old.content) === fingerprint(claim.content)) continue;
					const next = this.claim(run.source, claim);
					// Local extraction may already have added the replacement from this source.
					const existing = run.memories.find((m) => m.id !== old.id && m.kind === claim.kind && fingerprint(m.content) === fingerprint(claim.content));
					if (!next && !existing) continue;
					if (existing && claims.some((c) => c.replaces === existing.id)) throw new Error("Cyclic memory replacement");
					this.block(old);
					after.set(old.id, { ...old, status: "forgotten", updatedAt: run.source.createdAt, revision: old.revision + 1 });
					if (next) after.set(next.id, next);
				} else {
					const next = this.claim(run.source, claim);
					if (next) after.set(next.id, next);
				}
			}
			const event = this.record("model", `${model}: ${run.source.id}`, [...after.values()], run.source.scope);
			this.db.prepare("UPDATE sources SET state='done',lease=0 WHERE id=?").run(run.source.id);
			return event;
		});
	}
	failEvolution(run: EvolutionRun): void {
		this.db.prepare("UPDATE sources SET state='failed',lease=0 WHERE id=? AND attempt=? AND state='running'").run(run.source.id, run.attempt);
	}
	act(id: string, type: MemoryAction, value?: string): string {
		return this.transaction(() => {
			const old = this.get(id);
			if (!old) throw new Error("Unknown memory id");
			const at = new Date().toISOString();
			let next = { ...old, updatedAt: at, revision: old.revision + 1 };
			const changes: DurableMemory[] = [];
			if (type === "forget" || type === "correct") {
				this.block(old);
				for (const duplicate of this.readMemories(old.scope)) {
					if (duplicate.id !== id && duplicate.scope === old.scope && fingerprint(duplicate.content) === fingerprint(old.content))
						changes.push({ ...duplicate, status: "forgotten", updatedAt: at, revision: duplicate.revision + 1 });
				}
			}
			switch (type) {
				case "correct": {
					const content = redact(value ?? "").trim();
					if (content.length < 4 || content.length > 480 || content.includes("[REDACTED")) throw new Error("Correction must be 4–480 characters without credentials");
					next = { ...next, content, status: "confirmed" }; break;
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
		return this.db.prepare(scope ? "SELECT data FROM events WHERE scope=? ORDER BY rowid DESC LIMIT 10" : "SELECT data FROM events ORDER BY rowid DESC LIMIT 10")
			.all(...(scope ? [scope] : [])).map((row) => JSON.parse(String(row.data)) as Event);
	}
	undo(id: string): string {
		return this.transaction(() => {
			const row = this.db.prepare("SELECT data FROM events WHERE id=?").get(id);
			if (!row) throw new Error("Unknown event id");
			const event: Event = JSON.parse(String(row.data));
			if (!event.after.length) throw new Error("Event has no memory changes");
			const at = new Date().toISOString();
			const restored = event.after.map((after, i) => {
				if (JSON.stringify(this.get(after.id)) !== JSON.stringify(after)) throw new Error("Memory changed since this event; undo refused");
				this.block(after);
				return { ...(event.before[i] ?? { ...after, status: "forgotten" as const }), revision: after.revision + 1, updatedAt: at };
			});
			return this.record("manual", `Undo ${id}`, restored, event.scope);
		});
	}
	status(): string {
		const health = this.db.prepare("PRAGMA quick_check").get();
		if (health?.quick_check !== "ok") throw new Error("Memory database integrity check failed");
		const jobs = this.db.prepare("SELECT state,COUNT(*) AS n FROM sources GROUP BY state").all();
		return `${this.readMemories().length} memories; ${jobs.map((j) => `${j.state}=${j.n}`).join(", ") || "no sources"}; SQLite ok`;
	}
}

function isMemory(value: unknown): value is DurableMemory {
	if (!value || typeof value !== "object") return false;
	const m = value as DurableMemory;
	return typeof m.id === "string" && !!m.id && MEMORY_KINDS.has(m.kind) && typeof m.content === "string" && !!m.content.trim()
		&& typeof m.scope === "string" && !!m.scope && typeof m.sourceEntryId === "string"
		&& typeof m.createdAt === "string" && typeof m.updatedAt === "string"
		&& Number.isFinite(Date.parse(m.createdAt)) && Number.isFinite(Date.parse(m.updatedAt))
		&& Number.isInteger(m.revision) && m.revision > 0 && ["durable", "pinned"].includes(m.layer)
		&& ["provisional", "confirmed", "forgotten", "conflicted"].includes(m.status);
}
