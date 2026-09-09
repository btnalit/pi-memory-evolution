import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './memory-store.ts';
import { Database } from './sqlite.ts';
import { selectRelevantMemories, excerpt } from './retriever.ts';
import { nominateProgress } from './progress-targets.ts';

const old = (content = 'Atlas uses SQLite.', kind = 'fact') => ({ version: 1, id: 'legacy-fact', kind, sourceEntryId: 'old', createdAt: '2026-01-01T00:00:00Z', content });
const using = (fn: (dir: string) => void) => { const dir = mkdtempSync(join(tmpdir(), 'pme-reliability-')); try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('empty primary or auxiliary ledgers do not consume the explicit import opportunity', () => {
 for (const name of ['memories.jsonl','memory-actions.jsonl']) using(dir => {
  writeFileSync(join(dir, name), '');
  const first = new MemoryStore(dir); assert.match(first.legacyStatus(), /not_found/); first.close();
  writeFileSync(join(dir, 'memories.jsonl'), JSON.stringify(old()));
  const s = new MemoryStore(dir);
  try {
   assert.deepEqual(s.importLegacy(), { state: 'completed', imported: 1 });
   s.act('legacy-fact','forget');
   assert.deepEqual(s.importLegacy(), { state: 'completed', imported: 0 });
   assert.equal(s.readMemories()[0].status, 'forgotten');
  } finally { s.close(); }
 });
});

test('upgrade reopens only a provably empty v6 import, even if valid files were supplied later', () => using(dir => {
 new MemoryStore(dir).close();
 const db = new Database(join(dir,'memory.sqlite'));
 const digest = createHash('sha256').update(JSON.stringify([null,''])).digest('hex');
 db.prepare("UPDATE metadata SET value=? WHERE key='legacy_import'").run(JSON.stringify({state:'completed',count:0,digest}));
 db.exec("UPDATE metadata SET value='6' WHERE key='schema'"); db.close();
 writeFileSync(join(dir,'memories.jsonl'),JSON.stringify(old()));
 const s = new MemoryStore(dir);
 try { assert.deepEqual(s.importLegacy(), {state:'completed',imported:1}); }
 finally { s.close(); }
}));

test('a real consumed ledger with zero derived claims is not replayed based on count alone', () => using(dir => {
 writeFileSync(join(dir,'memories.jsonl'),JSON.stringify(old('Unstructured historical summary.', 'compaction_summary')));
 const first = new MemoryStore(dir); assert.match(first.legacyStatus(), /completed; imported=0/); first.close();
 writeFileSync(join(dir,'memories.jsonl'),JSON.stringify(old()));
 const db = new Database(join(dir,'memory.sqlite')); db.exec("UPDATE metadata SET value='6' WHERE key='schema'"); db.close();
 const s = new MemoryStore(dir);
 try { assert.deepEqual(s.importLegacy(), {state:'completed',imported:0}); assert.equal(s.readMemories().length,0); }
 finally { s.close(); }
}));

test('schema 6 scheduling upgrade retains claims and receipts, separates route waits from source backoff', () => using(dir => {
 const before = new MemoryStore(dir);
 before.capture({id:'pending',scope:'/fixture',kind:'summary',content:'## Critical Context\n- Atlas uses SQLite.',createdAt:new Date().toISOString()});
 before.capture({id:'failed',scope:'/fixture',kind:'user',content:'Remember Atlas.',createdAt:new Date().toISOString()});
 const now = Date.now(); before.failEvolution(before.beginEvolution('failed',false,undefined,now,'p/m')!,'provider',now);
 const records = before.readMemories(), history = before.history(); before.close();
 const db = new Database(join(dir,'memory.sqlite'));
 try {
  db.exec("UPDATE metadata SET value='6' WHERE key='schema'");
  db.prepare('UPDATE sources SET retry_at=?').run(now+3_600_000);
  for (const column of ['calls','call_ms','call_models','last_checked','corrections']) db.exec(`ALTER TABLE sources DROP COLUMN ${column}`);
  const migrated = new MemoryStore(dir);
  try {
   assert.deepEqual(migrated.readMemories(),records); assert.deepEqual(migrated.history(),history);
   assert.equal(db.prepare("SELECT retry_at FROM sources WHERE id='pending'").get()!.retry_at,0);
   assert.equal(db.prepare("SELECT retry_at FROM sources WHERE id='failed'").get()!.retry_at,now+60_000);
   assert.equal(migrated.routingInfo('failed').calls,1);
   assert.deepEqual(migrated.routingInfo('failed').models,['p/m']);
  } finally { migrated.close(); }
 } finally { db.close(); }
}));

test('exact literals preserve case in recall, excerpts and update nomination', () => using(dir => {
 const s = new MemoryStore(dir);
 try {
  s.capture({id:'case',scope:'/fixture',kind:'summary',content:'## Critical Context\n- /srv/atlas/config.json uses port 9999.\n## Progress\n- /srv/atlas changes pending.',createdAt:new Date().toISOString()});
  assert.equal(selectRelevantMemories(s.readMemories(), '/srv/Atlas/config.json port').length,0);
  assert.equal(selectRelevantMemories(s.readMemories(), '/srv/atlas/config.json port').length,1);
  const result = nominateProgress(s.readMemories(), {scope:'/fixture',query:'continue',resources:[{path:'/srv/Atlas',name:'Atlas',kind:'directory'}]});
  assert.deepEqual(result.targets,[]);
  const long = 'Unrelated prefix '.repeat(100) + '/srv/Atlas/config.json uses port 7777.';
  assert.match(excerpt(long,'/srv/Atlas/config.json',150),/\/srv\/Atlas\/config.json/);
 } finally { s.close(); }
}));
