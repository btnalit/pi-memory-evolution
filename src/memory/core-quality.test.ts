import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type DurableMemory, type Source } from "./memory-store.ts";
import { Database } from "./sqlite.ts";
import { AGING, memoryQuality, evidencePriority, validEvidence, validFeedback } from "./quality.ts";
import { feedbackCue } from "./feedback.ts";
import { parseClaims } from "./evolution.ts";
import { retrieveMemories, selectRelevantMemories } from "./retriever.ts";
import { buildRuntimeDigest } from "../injector/digest.ts";

const now = Date.parse("2026-09-07T12:00:00Z"), DAY = 86400_000;
const iso = (days = 0) => new Date(now - days * DAY).toISOString();
const source = (id: string, kind: Source["kind"] = "summary", content = "## Critical Context\n- Atlas database port is 5432.", days = 0): Source =>
	({ id, kind, content, createdAt: iso(days), scope: "/atlas" });
const memory = (id: string, extra: Partial<DurableMemory> = {}): DurableMemory => ({ id, kind: "fact", content: "Atlas database port is 5432.", scope: `/origin/${id}`,
	sourceEntryId: id, createdAt: iso(), updatedAt: iso(), revision: 1, status: "provisional", layer: "durable", ...extra });
function using(fn: (s: MemoryStore, dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "pme-core-quality-")); const s = new MemoryStore(dir);
	try { fn(s, dir); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
}
function learn(s: MemoryStore, input: Source, kind: DurableMemory["kind"], content: string, replaces?: string) {
	s.capture(input); return s.finishEvolution(s.beginEvolution(input.id)!, [{ kind, content, ...(replaces ? { replaces } : {}) }], "fake/model");
}

test("host assigns source-specific evidence; a model cannot invent verification fields", () => using(s => {
	s.capture(source("summary")); const initial = s.readMemories()[0];
	assert.deepEqual(initial.evidence, { basis: "summary", method: "local", sourceId: "summary", at: iso() });
	learn(s, source("user", "user", "Remember Atlas uses port 7777."), "fact", "Atlas database port is 7777.", initial.id);
	const user = s.readMemories().find(m => m.status === "provisional")!;
	assert.equal(user.evidence?.basis, "user_statement"); assert.equal(user.evidence?.method, "model");
	assert.equal(user.status, "provisional");
	for (const field of ["confidence", "evidence", "feedback", "verified"]) assert.throws(() => parseClaims(JSON.stringify({ memories: [{ kind: "fact", content: "Valid fact.", [field]: 1 }] })));
}));

test("tool observation labels do not certify success and apply only to nominated states", () => using(s => {
	s.capture(source("state", "summary", "## Progress\n- Atlas push pending.", 2)); const old = s.readMemories()[0];
	learn(s, { ...source("tool", "progress", "git push failed"), targets: [old.id] }, "project_state", "Atlas push failed; still pending.", old.id);
	const fresh = s.readMemories().find(m => m.status === "provisional")!;
	assert.equal(fresh.evidence?.basis, "tool_observation"); assert.equal(fresh.status, "provisional");
	assert.match(fresh.content, /failed/);
}));

test("weaker summary replacement is quarantined, stronger preference remains recallable and undo works", () => using(s => {
	learn(s, source("user", "user", "I prefer Atlas dark fonts.", 2), "preference", "Atlas font preference is dark.");
	const original = s.readMemories()[0];
	const event = learn(s, source("weak", "summary", "## Constraints & Preferences\n- Atlas font preference is light."), "preference", "Atlas font preference is light.", original.id);
	assert.deepEqual(s.readMemories().find(m => m.id === original.id), original);
	assert.equal(s.readMemories().find(m => m.content.endsWith("light."))!.status, "conflicted");
	assert.deepEqual(selectRelevantMemories(s.readMemories(), "Atlas font", 3, now).map(m => m.id), [original.id]);
	assert.match(s.history()[0].reason, /weaker replacements withheld=1/);
	s.undo(event); assert.equal(s.readMemories().find(m => m.id === original.id)!.status, "provisional");
}));

test("weak replacement cannot bypass quarantine with duplicate model additions", () => using(s => {
	learn(s, source("user", "user", "Remember Atlas port.", 2), "fact", "Atlas database port is 5432."); const old = s.readMemories()[0];
	s.capture(source("weak", "summary", "unstructured source"));
	s.finishEvolution(s.beginEvolution("weak")!, [
		{ kind: "decision", content: "Atlas database port is 1111." },
		{ kind: "fact", content: "Atlas database port is 1111.", replaces: old.id },
		{ kind: "fact", content: "Atlas database port is 1111." },
	], "fake/model");
	assert.ok(s.readMemories().filter(m => m.content.includes("1111")).every(m => m.status === "conflicted"));
	assert.deepEqual(selectRelevantMemories(s.readMemories(), "Atlas database port", 3, now).map(m => m.id), [old.id]);
}));

test("a later replacement in the same batch cannot revive a quarantined existing variant", () => using(s => {
	learn(s, source("user", "user", "Remember Atlas port.", 3), "fact", "Atlas database port is 5432."); const strong = s.readMemories()[0];
	s.capture(source("older", "summary", "## Critical Context\n- Atlas secondary port is 8888.", 2));
	const other = s.readMemories().find(m => m.content.includes("8888"))!;
	s.capture(source("weak", "summary", "## Critical Context\n- Atlas database port is 1111."));
	s.finishEvolution(s.beginEvolution("weak")!, [
		{ kind: "fact", content: "Atlas database port is 1111.", replaces: strong.id },
		{ kind: "fact", content: "Atlas database port is 1111.", replaces: other.id },
	], "fake/model");
	assert.equal(s.readMemories().find(m => m.content.includes("1111"))!.status, "conflicted");
	assert.equal(s.readMemories().find(m => m.id === other.id)!.status, "provisional");
}));

test("manual corrections are evidence, not pins; newer user correction still updates automatically", () => using(s => {
	s.capture(source("initial", "summary", undefined, 2)); const old = s.readMemories()[0];
	s.act(old.id, "correct", "Atlas database port is 7777."); const corrected = s.readMemories()[0];
	assert.equal(corrected.evidence?.basis, "manual_correction"); assert.equal(corrected.evidence?.method, "manual");
	const future = new Date(Date.parse(corrected.updatedAt) + 1000).toISOString();
	learn(s, { ...source("weak", "summary", "wrong old summary"), createdAt: future }, "fact", "Atlas database port is 1111.", old.id);
	assert.equal(s.readMemories().find(m => m.id === old.id)!.content, corrected.content);
	learn(s, { ...source("user", "user", "Correction: Atlas port is 9999."), createdAt: future }, "fact", "Atlas database port is 9999.", old.id);
	assert.equal(s.readMemories().find(m => m.id === old.id)!.status, "forgotten");
	assert.ok(s.readMemories().some(m => m.content.includes("9999") && m.status === "provisional"));
}));

test("fresh tool observations can update manually corrected project state without requiring unpin", () => using(s => {
	s.capture(source("state", "summary", "## Progress\n- Atlas push pending.")); const old = s.readMemories()[0];
	s.act(old.id, "correct", "Atlas push is still pending."); const corrected = s.readMemories()[0];
	learn(s, { ...source("tool", "progress", "push succeeded"), targets: [old.id], createdAt: new Date(Date.parse(corrected.updatedAt) + 1000).toISOString() }, "project_state", "Atlas push completed.", old.id);
	assert.equal(s.readMemories().find(m => m.id === old.id)!.status, "forgotten");
	assert.equal(s.readMemories().find(m => m.status === "provisional")!.evidence?.basis, "tool_observation");
}));

test("alias-only and repeated compactions do not refresh or strengthen evidence", () => using(s => {
	s.capture(source("old", "summary", undefined, 4)); const before = s.readMemories()[0];
	s.capture(source("repeat"));
	s.finishEvolution(s.beginEvolution("repeat")!, [{ kind: "fact", content: before.content, searchTerms: ["database"] }], "fake/model");
	const after = s.readMemories()[0];
	assert.equal(after.updatedAt, before.updatedAt); assert.deepEqual(after.evidence, before.evidence);
	assert.equal(memoryQuality(after, now).evidenceWeight, memoryQuality(before, now).evidenceWeight);
}));

test("explicit reaffirmation incorporates a new source without inheriting false verification", () => using(s => {
	s.capture(source("old", "summary", undefined, 4)); const before = s.readMemories()[0];
	learn(s, source("new", "user", "Remember Atlas still uses port 5432."), "fact", before.content, before.id);
	const after = s.readMemories()[0]; assert.equal(after.updatedAt, iso());
	assert.equal(after.evidence?.basis, "user_statement"); assert.equal(after.status, "provisional");
}));

test("replacement reusing an existing claim incorporates fresh evidence rather than only aliases", () => using(s => {
	s.capture(source("old", "summary", undefined, 4)); const original = s.readMemories()[0];
	s.capture(source("existing", "summary", "## Critical Context\n- Atlas database port is 7777.", 3));
	learn(s, source("new", "user", "Correction: Atlas port is 7777."), "fact", "Atlas database port is 7777.", original.id);
	const next = s.readMemories().find(m => m.status === "provisional")!;
	assert.equal(next.sourceEntryId, "new"); assert.equal(next.updatedAt, iso()); assert.equal(next.evidence?.basis, "user_statement");
}));

test("typed decay is gradual, bounded and does not erase stable knowledge", () => {
	for (const kind of Object.keys(AGING) as DurableMemory["kind"][]) {
		const fresh = memoryQuality(memory(kind, { kind }), now);
		const aged = memoryQuality(memory(kind, { kind, updatedAt: iso(3) }), now);
		const ancient = memoryQuality(memory(kind, { kind, updatedAt: iso(3650) }), now);
		assert.equal(fresh.freshness, 1); assert.ok(aged.freshness < fresh.freshness); assert.ok(ancient.freshness >= AGING[kind].floor);
		assert.equal(ancient.expired, kind === "project_state");
	}
	assert.ok(memoryQuality(memory("p", { kind: "preference", updatedAt: iso(3) }), now).freshness > memoryQuality(memory("s", { kind: "project_state", updatedAt: iso(3) }), now).freshness);
	assert.equal(memoryQuality(memory("future", { updatedAt: iso(-5) }), now).freshness, 1);
});

test("pinning exempts age only, never invents evidence or rescues an unrelated memory", () => {
	const old = memory("old", { kind: "project_state", updatedAt: iso(100), layer: "pinned" });
	const quality = memoryQuality(old, now); assert.equal(quality.freshness, 1); assert.equal(quality.expired, false); assert.equal(quality.basis, "unknown");
	assert.deepEqual(selectRelevantMemories([old], "Bluetooth audio", 3, now), []);
});

test("ranking separates lexical relevance, evidence, utility and age without a popularity counter", () => {
	const baseline = memory("a");
	const observed = memory("b", { evidence: { basis: "manual_correction", method: "manual", sourceId: "manual:1", at: iso() } });
	const ranked = retrieveMemories([baseline, observed], "Atlas database port", 3, now);
	assert.equal(ranked.selected[0].id, "b");
	const [b, a] = ranked.diagnostics.candidates;
	assert.equal(b.score, a.score); assert.ok(b.rankScore > a.rankScore);
	assert.equal(b.quality.evidenceWeight, 1.16);
	assert.ok(evidencePriority("preference", "user_statement") > evidencePriority("fact", "user_statement"));
	const preferred = memory("c", { feedback: { utility: { verdict: "useful", sourceId: "feedback:1", at: iso() } } });
	assert.equal(memoryQuality(preferred, now).evidenceWeight, memoryQuality(baseline, now).evidenceWeight);
	assert.equal(retrieveMemories([baseline, preferred], "Atlas database port", 3, now).selected[0].id, "c");
});

test("quality cannot bypass subject, coverage, literal and relative-relevance gates", () => {
	const high = memory("weak", { content: "Database port is 5432.", layer: "pinned", evidence: { basis: "manual_correction", method: "manual", sourceId: "manual:1", at: iso() },
		feedback: { utility: { verdict: "useful", sourceId: "f:1", at: iso() }, accuracy: { verdict: "accurate", sourceId: "f:2", at: iso() } } });
	assert.deepEqual(selectRelevantMemories([high], "/srv/atlas/settings.json database port", 3, now), []);
	assert.deepEqual(selectRelevantMemories([high], "Kubernetes network authentication", 3, now), []);
	assert.deepEqual(selectRelevantMemories([high], "continue", 3, now), []);
});

test("feedback persists, is replay-idempotent, undoable and never refreshes the evidence clock", () => using((s, dir) => {
	s.capture(source("old", "summary", undefined, 5)); const before = s.readMemories()[0];
	const event = s.feedback(before.id, "useful", "user:feedback", iso())!;
	assert.equal(s.readMemories()[0].updatedAt, before.updatedAt);
	assert.equal(s.feedback(before.id, "useful", "user:feedback", iso()), undefined);
	assert.equal(s.feedback(before.id, "useful", "user:repeat", iso()), undefined);
	const second = new MemoryStore(dir);
	try { assert.deepEqual(second.readMemories(), s.readMemories()); assert.equal(second.feedback(before.id, "useful", "user:feedback", iso()), undefined); }
	finally { second.close(); }
	s.undo(event); assert.equal(s.readMemories()[0].feedback, undefined);
	assert.equal(s.feedback(before.id, "useful", "user:feedback", iso()), undefined);
	assert.equal(s.readMemories()[0].feedback, undefined);
}));

test("a late older feedback event cannot reverse the latest explicit verdict", () => using(s => {
	s.capture(source("old")); const id = s.readMemories()[0].id;
	s.feedback(id, "unhelpful", "new", iso()); s.feedback(id, "useful", "late", iso(1));
	assert.equal(s.readMemories()[0].feedback?.utility?.verdict, "unhelpful");
}));

test("a repeated verdict still prevents an intervening older verdict from taking over", () => using(s => {
	s.capture(source("old", "summary", undefined, 4)); const id = s.readMemories()[0].id;
	s.feedback(id, "unhelpful", "first", iso(3));
	assert.equal(s.feedback(id, "unhelpful", "repeat", iso()), undefined);
	s.feedback(id, "useful", "late", iso(2));
	assert.equal(s.readMemories()[0].feedback?.utility?.verdict, "unhelpful");
}));

test("feedback about an older revision cannot quarantine a later manual correction", () => using(s => {
	s.capture(source("old", "summary", undefined, 4)); const id = s.readMemories()[0].id;
	s.act(id, "correct", "Atlas port is 7777.");
	assert.equal(s.feedback(id, "incorrect", "late", iso(3)), undefined);
	assert.equal(s.readMemories()[0].status, "confirmed");
}));

test("incorrect feedback quarantines same-origin exact duplicates, not other origins, and retires observers", () => using((s, dir) => {
	s.capture(source("old")); const old = s.readMemories()[0];
	const db = new Database(join(dir, "memory.sqlite"));
	try { db.prepare("INSERT INTO memories SELECT ?,scope,hash,? FROM memories WHERE id=?").run("legacy-duplicate", JSON.stringify({ ...old, id: "legacy-duplicate" }), old.id); }
	finally { db.close(); }
	s.capture({ ...source("other"), scope: "/other" });
	s.capture(source("pending"));
	const event = s.feedback(old.id, "incorrect", "user:wrong", iso())!;
	assert.equal(s.beginEvolution("pending"), undefined);
	assert.ok(s.readMemories("/atlas").every(m => m.status === "conflicted"));
	assert.deepEqual(selectRelevantMemories(s.readMemories(), "Atlas database port", 3, now).map(m => m.scope), ["/other"]);
	assert.throws(() => s.feedback(old.id, "accurate"));
	s.undo(event); assert.ok(s.readMemories("/atlas").every(m => m.status === "provisional"));
	assert.equal(s.feedback(old.id, "incorrect", "user:wrong", iso()), undefined);
}));

test("correction clears old feedback, resolve and bookkeeping cannot rejuvenate stale states", () => using(s => {
	s.capture(source("old", "summary", "## Progress\n- Atlas push pending.", 20)); const old = s.readMemories()[0];
	s.feedback(old.id, "incorrect", "user:wrong", iso()); s.act(old.id, "resolve");
	assert.equal(s.readMemories()[0].updatedAt, old.updatedAt);
	assert.deepEqual(selectRelevantMemories(s.readMemories(), "Atlas push", 3, now), []);
	s.act(old.id, "correct", "Atlas push failed; remote unavailable.");
	assert.equal(s.readMemories()[0].feedback, undefined); assert.equal(s.readMemories()[0].evidence?.basis, "manual_correction");
}));

test("manual two-sided conflict and resolution preserve both evidence clocks", () => using(s => {
	s.capture(source("old", "summary", "## Progress\n- Atlas push pending.", 20));
	s.capture(source("other", "summary", "## Progress\n- Atlas push completed.", 19));
	const [a,b] = s.readMemories(); s.act(a.id, "conflict", b.id);
	assert.equal(s.readMemories().find(m => m.id === a.id)!.updatedAt, a.updatedAt);
	assert.equal(s.readMemories().find(m => m.id === b.id)!.updatedAt, b.updatedAt);
	s.act(a.id, "resolve");
	assert.deepEqual(selectRelevantMemories(s.readMemories(), "Atlas push", 3, now), []);
}));

test("feedback wins against an in-flight model replacement", () => using(s => {
	s.capture(source("old")); const old = s.readMemories()[0]; const run = s.beginEvolution("old")!;
	s.feedback(old.id, "useful", "user:feedback", iso());
	assert.throws(() => s.finishEvolution(run, [{ kind: "fact", content: "Atlas port is 7777.", replaces: old.id }], "fake/model"), /stale/);
}));

test("feedback parser accepts only whole exact-ID statements, not quotes, questions or vague criticism", () => {
	const id = "a".repeat(24);
	assert.deepEqual(feedbackCue(`记忆 ${id} 有用。`), { id, verdict: "useful" });
	assert.deepEqual(feedbackCue(`Memory ${id} is incorrect.`), { id, verdict: "incorrect" });
	for (const text of ["不对", `记忆 ${id} 有用吗？`, `例子：记忆 ${id} 错误`, `\`memory ${id} incorrect\``, `Do not mark memory ${id} incorrect`, `memory ${id} accurate\nmemory ${id} incorrect`]) assert.equal(feedbackCue(text), undefined);
});

test("schema 4 migration preserves byte-for-byte records/history and leaves missing evidence unknown", () => using((s, dir) => {
	s.capture(source("old", "summary", undefined, 10));
	const db = new Database(join(dir, "memory.sqlite"));
	try {
		// Recreate v4 metadata-free JSON, not just a downgraded version marker.
		db.exec("UPDATE memories SET data=json_remove(data,'$.evidence'); DROP TABLE feedback_receipts; UPDATE metadata SET value='4' WHERE key='schema'");
		for (const row of db.prepare("SELECT id,data FROM events").all()) {
			const event = JSON.parse(String(row.data));
			for (const m of [...event.before, ...event.after]) if (m) delete m.evidence;
			db.prepare("UPDATE events SET data=? WHERE id=?").run(JSON.stringify(event), row.id!);
		}
		const before = db.prepare("SELECT * FROM memories").all(), history = db.prepare("SELECT * FROM events").all();
		const migrated = new MemoryStore(dir);
		try {
			assert.deepEqual(db.prepare("SELECT * FROM memories").all(), before);
			assert.deepEqual(db.prepare("SELECT * FROM events").all(), history);
			assert.equal(migrated.history().length, 1);
			assert.equal(migrated.readMemories()[0].evidence, undefined);
			assert.equal(memoryQuality(migrated.readMemories()[0], now).basis, "unknown");
			assert.match(migrated.status(), /schema 7/);
		} finally { migrated.close(); }
	} finally { db.close(); }
}));

test("invalid evidence and feedback fail closed rather than changing retrieval authority", () => using((s, dir) => {
	assert.equal(validEvidence({ basis: "manual_correction", method: "model", sourceId: "a", at: iso() }), false);
	assert.equal(validFeedback({ utility: { verdict: "accurate", sourceId: "a", at: iso() } }), false);
	s.capture(source("old")); const old = s.readMemories()[0]; const db = new Database(join(dir, "memory.sqlite"));
	try {
		for (const patch of [{ evidence: { basis: "verified", method: "model", sourceId: "a", at: iso() } }, { feedback: { accuracy: { verdict: "accurate", at: "bad", sourceId: "a" } } }]) {
			db.prepare("UPDATE memories SET data=? WHERE id=?").run(JSON.stringify({ ...old, ...patch }), old.id);
			assert.throws(() => s.readMemories(), /Invalid memory/);
		}
	} finally { db.close(); }
}));

test("short named-attribute queries do not fall back to a different subject or attribute", () => {
	for (const [subject, other, attribute, wrongAttribute] of [
		["SQLite", "PostgreSQL", "authentication", "timeout"],
		["Cedar", "Maple", "version", "price"],
		["Arabica", "Robusta", "price", "version"],
	]) {
		const wanted = memory("wanted", { content: `${subject} ${attribute} is alpha.` });
		const wrongSubject = memory("other", { content: `${other} ${attribute} is beta.` });
		const wrongFacet = memory("facet", { content: `${subject} ${wrongAttribute} is gamma.` });
		assert.deepEqual(selectRelevantMemories([wanted, wrongSubject, wrongFacet], `${subject} ${attribute}`, 3, now).map(m => m.id), ["wanted"]);
		const result = retrieveMemories([{ ...wanted, status: "conflicted" }, wrongSubject, wrongFacet], `${subject} ${attribute}`, 3, now);
		assert.deepEqual(result.selected, []);
		assert.ok(result.diagnostics.candidates.every(c => c.reason === "subject-attribute-mismatch"));
	}
	assert.equal(selectRelevantMemories([memory("db", { content: "Database port is 5432." })], "Remember database port is now 7777.", 3, now).length, 1);
	assert.equal(selectRelevantMemories([memory("db", { content: "Database port is 5432." })], "数据库端口是多少？", 3, now).length, 1);
});

test("quality metadata is copied, not a mutable alias into the store cache", () => using(s => {
	s.capture(source("old")); const id = s.readMemories()[0].id; s.feedback(id, "useful", "user:f", iso());
	const copy = s.readMemories()[0]; copy.evidence!.basis = "manual_correction"; copy.feedback!.utility!.verdict = "unhelpful";
	assert.equal(s.readMemories()[0].evidence!.basis, "summary"); assert.equal(s.readMemories()[0].feedback!.utility!.verdict, "useful");
}));

test("digest exposes evidence limits and aging within the byte budget; diagnostics explain expiry", () => {
	const records = [memory("a", { updatedAt: iso(150) }), memory("b"), memory("c")];
	const digest = buildRuntimeDigest(records, "Atlas database port", now)!;
	assert.ok(Buffer.byteLength(digest) <= 2048); assert.match(digest, /not verification/); assert.match(digest, /unknown\/unknown/); assert.match(digest, /"aging":true/);
	const stale = memory("stale", { kind: "project_state", updatedAt: iso(8) });
	assert.equal(retrieveMemories([stale], "Atlas database", 3, now).diagnostics.exclusions![0].reason, "expired-project-state");
});
