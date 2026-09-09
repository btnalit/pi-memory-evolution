import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MemoryStore, type Source } from './memory-store.ts';
import { Database } from './sqlite.ts';
import { EVOLUTION_TIMEOUT_MS, LEASE_GRACE_MS, MAX_FAILURES, MAX_OUTPUT_FAILURES, retryAt } from './recovery.ts';

const source = (id = 's'): Source => ({ id, kind: 'summary', scope: '/old-origin', content: '## Critical Context\n- Database uses SQLite.', createdAt: '2026-09-01T00:00:00Z' });
function using(fn: (s: MemoryStore, db: Database, dir: string) => void) {
 const dir = mkdtempSync(join(tmpdir(), 'pme-recovery-'));
 const s = new MemoryStore(dir), db = new Database(join(dir, 'memory.sqlite'));
 try { fn(s, db, dir); } finally { db.close(); s.close(); rmSync(dir, { recursive: true, force: true }); }
}
const job = (db: Database, id = 's') => db.prepare('SELECT * FROM sources WHERE id=?').get(id)!;

test('automatic retries persist exact backoff and cannot bypass due time or failure cap', () => using((s, db, dir) => {
 s.capture(source()); let now = Date.now();
 const delays = [60_000, 300_000, 900_000, 3_600_000];
 for (let failures = 1; failures <= MAX_FAILURES; failures++) {
  const run = s.beginEvolution('s', 'auto', EVOLUTION_TIMEOUT_MS, now)!; assert.ok(run);
  s.failEvolution(run, 'timeout', now);
  assert.equal(job(db).failures, failures); assert.equal(job(db).last_error, 'timeout');
  const reopened = new MemoryStore(dir);
  try {
   assert.equal(reopened.pending(undefined, 'auto', now), undefined);
   if (failures < MAX_FAILURES) {
    const due = now + delays[failures - 1];
    assert.equal(job(db).retry_at, due);
    assert.equal(reopened.beginEvolution('s', 'auto', EVOLUTION_TIMEOUT_MS, due - 1), undefined);
    assert.equal(reopened.pending(undefined, 'auto', due), 's'); now = due;
   } else {
    assert.equal(job(db).retry_at, 0);
    assert.equal(reopened.pending(undefined, 'auto', now + 30 * 86400_000), undefined);
    assert.match(reopened.status(), /paused=1/);
   }
  } finally { reopened.close(); }
 }
 // Explicit one-off override is retained, not required for ordinary recovery.
 const manual = s.beginEvolution('s', true)!; s.finishEvolution(manual, [], 'test');
 assert.equal(job(db).state, 'done'); assert.equal(job(db).last_error, '');
 assert.equal(s.pending(undefined, 'auto', now), undefined);
}));

test('lease exceeds model deadline and expired work is recovered once with durable backoff', () => using((s, db, dir) => {
 s.capture(source()); const now = Date.now(); const old = s.beginEvolution('s', 'auto', EVOLUTION_TIMEOUT_MS, now)!;
 assert.equal(job(db).lease, now + EVOLUTION_TIMEOUT_MS + LEASE_GRACE_MS);
 const second = new MemoryStore(dir);
 try {
  second.recoverExpired(now + 60_001); assert.equal(job(db).state, 'running');
  assert.equal(second.beginEvolution('s', true, EVOLUTION_TIMEOUT_MS, now + 60_001), undefined);
  const expired = Number(job(db).lease); second.recoverExpired(expired); second.recoverExpired(expired);
  assert.equal(job(db).state, 'failed'); assert.equal(job(db).failures, 1); assert.equal(job(db).last_error, 'interrupted');
  const due = Number(job(db).retry_at);
  const newer = second.beginEvolution('s', 'auto', EVOLUTION_TIMEOUT_MS, due)!; assert.ok(newer);
  assert.equal(s.beginEvolution('s', 'auto', EVOLUTION_TIMEOUT_MS, due), undefined);
  assert.throws(() => s.finishEvolution(old, [], 'late'), /stale/);
  s.failEvolution(old, 'provider', due); assert.equal(job(db).state, 'running'); assert.equal(job(db).failures, 1);
  second.finishEvolution(newer, [], 'recovered'); assert.equal(job(db).state, 'done');
 } finally { second.close(); }
}));

test('shutdown cancellation releases a job without exhausting recovery budgets', () => using((s, db) => {
 s.capture(source());
 for (let i = 0; i < 8; i++) s.failEvolution(s.beginEvolution('s', 'auto')!, 'cancelled');
 assert.equal(job(db).failures, 0); assert.equal(job(db).state, 'pending');
 assert.equal(s.pending(undefined, 'auto'), 's');
}));

test('a failing source does not starve other origins, and forget retires scheduled retries', () => using((s, db) => {
 s.capture(source('first')); s.capture({ ...source('second'), scope: '/another-origin' });
 assert.equal(s.pending(undefined, 'auto'), 'first');
 s.failEvolution(s.beginEvolution('first', 'auto')!, 'invalid_output');
 assert.equal(s.pending(undefined, 'auto'), 'second');
 const memory = s.readMemories('/old-origin')[0]; s.act(memory.id, 'forget');
 assert.equal(job(db, 'first').state, 'done');
 assert.equal(s.beginEvolution('first', 'auto', EVOLUTION_TIMEOUT_MS, Date.now() + 86400_000), undefined);
}));

test('schema 3 migration adds recovery fields atomically, preserves data and discovers legacy failure', () => using((s, db, dir) => {
 s.capture(source()); s.failEvolution(s.beginEvolution('s')!);
 const records = s.readMemories(), history = s.history();
 // Reconstruct the actual old shape, not just a downgraded marker.
 db.exec('DROP INDEX sources_recovery; DROP INDEX sources_running_lease');
 for (const col of ['failures', 'retry_at', 'failed_at', 'last_error']) db.exec(`ALTER TABLE sources DROP COLUMN ${col}`);
 db.exec("UPDATE metadata SET value='3' WHERE key='schema'");
 const migrated = new MemoryStore(dir);
 try {
  assert.equal(migrated.pending(undefined, 'auto'), 's');
  assert.equal(job(db).failures, 1); assert.equal(job(db).attempt, 1);
  assert.equal(job(db).failed_at, 0); assert.equal(job(db).last_error, 'unknown');
  assert.deepEqual(migrated.readMemories(), records); assert.deepEqual(migrated.history(), history);
  assert.match(migrated.status(), /schema 7/); assert.match(migrated.status(), /unknown \(legacy\)/);
 } finally { migrated.close(); }
}));

test('failure diagnostics survive reopen, reject arbitrary text and validate numeric fields', () => using((s, db, dir) => {
 s.capture(source()); const run = s.beginEvolution('s')!;
 assert.throws(() => s.failEvolution(run, 'secret-provider-body' as any));
 s.failEvolution(run, 'output_limit');
 const reopened = new MemoryStore(dir);
 try { assert.match(reopened.status(), /output_limit.*attempts=1.*failedAt=.*nextRetry=/); } finally { reopened.close(); }
 db.exec("UPDATE sources SET last_error='secret-provider-body'"); assert.throws(() => s.status(), /Invalid source job/);
 db.exec("UPDATE sources SET last_error='timeout',retry_at=-1"); assert.throws(() => s.status(), /Invalid source job/);
}));

test('cancelling a manual override cannot silently unpause exhausted automatic work', () => using((s, db) => {
 s.capture(source());
 for (let i=0;i<5;i++) s.failEvolution(s.beginEvolution('s',true)!,'provider');
 s.failEvolution(s.beginEvolution('s',true)!,'cancelled');
 assert.equal(job(db).state,'failed'); assert.equal(s.pending(undefined,'auto'),undefined);
 assert.equal(job(db).failures,5);
}));

test('competing processes can claim a due failed source only once', async () => {
 const dir=mkdtempSync(join(tmpdir(),'pme-recovery-process-'));const s=new MemoryStore(dir);
 s.capture(source());s.failEvolution(s.beginEvolution('s')!,'provider',Date.now()-120_000);s.close();
 const module=new URL('./memory-store.ts',import.meta.url).href;
 try {
  const claims=await Promise.all(Array.from({length:4},()=>new Promise<number>((resolve,reject)=>{
   const code=`import {MemoryStore} from ${JSON.stringify(module)};const s=new MemoryStore(${JSON.stringify(dir)});console.log(s.beginEvolution('s','auto')?1:0);s.close();`;
   const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
   child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);
   child.on('exit',c=>c===0?resolve(Number(stdout.trim())):reject(new Error(stderr)));
  })));
  assert.equal(claims.reduce((a,b)=>a+b,0),1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('retry policy is bounded even after manual failures beyond the automatic cap', () => {
 assert.equal(retryAt(1, 100), 60_100); assert.equal(retryAt(4, 100), 3_600_100);
 assert.equal(retryAt(5, 100), 0); assert.equal(retryAt(100, 100), 0);
});

test('warning dedup is per source, error class and state, surviving reload and unrelated successes', () => using((s, db, dir) => {
 const now = Date.now();
 s.capture(source('a')); s.capture(source('b'));
 s.failEvolution(s.beginEvolution('a')!, 'provider', now, { reason: 'request_failed' });
 assert.equal(s.takeNotice(s.jobNoticeKey('a'), now), true, 'the first notice for a source/class is shown');
 // The reproduced defect: an unrelated job succeeding must not re-arm another job's warning.
 s.finishEvolution(s.beginEvolution('b')!, [], 'mock');
 s.failEvolution(s.beginEvolution('a', true)!, 'provider', now, { reason: 'request_failed' });
 assert.equal(s.takeNotice(s.jobNoticeKey('a'), now), false, 'an unchanged repeat failure must not warn again');
 // A genuinely different error class is a state change worth reporting once.
 s.failEvolution(s.beginEvolution('a', true)!, 'invalid_output', now, { reason: 'json_syntax' });
 const changed = s.jobNoticeKey('a');
 assert.equal(s.takeNotice(changed, now), true);
 assert.equal(s.takeNotice(changed, now), false);
 // Reload must not reset the marker: dedup is persisted, not an in-memory flag.
 const reopened = new MemoryStore(dir);
 try { assert.equal(reopened.takeNotice(changed, now), false, 'reload must not resurrect a suppressed warning'); }
 finally { reopened.close(); }
}));

test('repeated output-protocol failures pause a source before the generic failure cap', () => using((s, db) => {
 const now = Date.now();
 s.capture(source());
 for (let i = 0; i < MAX_OUTPUT_FAILURES; i++) s.failEvolution(s.beginEvolution('s', true)!, 'invalid_output', now, { reason: 'json_syntax' });
 assert.equal(Number(job(db).output_failures), MAX_OUTPUT_FAILURES);
 assert.ok(Number(job(db).failures) < MAX_FAILURES, 'pausing must not require burning the full paid budget');
 assert.equal(s.pausedJobs(), 1);
 assert.equal(s.pending(undefined, 'auto'), undefined, 'a paused source is not retried automatically');
 assert.equal(Number(job(db).retry_at), 0);
 // The single correction attempt carries fixed validation feedback, never the failed output.
 const run = s.beginEvolution('s', true)!;
 assert.equal(run.outputFailures, MAX_OUTPUT_FAILURES);
 assert.equal(run.previousDiagnostic.reason, 'json_syntax');
 s.finishEvolution(run, [], 'mock');
 assert.equal(Number(job(db).output_failures), 0); assert.equal(s.pausedJobs(), 0);
}));

test('a shared failure window stops each new source from burning its own retry budget', () => using((s, db) => {
 const model = 'provider/model';
 let now = Date.now();
 for (let i = 0; i < 2; i++) {
  s.capture(source(`s${i}`));
  const run = s.beginEvolution(`s${i}`, 'auto', undefined, now, model);
  assert.ok(run, `source ${i} must get its first attempt`);
  s.failEvolution(run, 'provider', now, {});
  now += 1000;
 }
 s.capture(source('fresh'));
 assert.equal(s.beginEvolution('fresh', 'auto', undefined, now, model), undefined, 'the shared window is not per source');
 const fresh = job(db, 'fresh');
 assert.equal(Number(fresh.attempt), 0, 'a deferred source consumes no attempt');
 assert.equal(Number(fresh.failures), 0, 'and no failure budget');
 assert.equal(fresh.state, 'pending');
 assert.equal(Number(fresh.retry_at), 0, 'route waits must not poison the source backoff');
 assert.equal(s.routeAvailable(model, 'provider', now), false);
 assert.match(s.budgetStatus('other/model', now), /available/, 'the budget is per model');
 // A manual override may probe the route, but not bypass the shared hard request ceiling.
 assert.ok(s.beginEvolution('fresh', true, undefined, now, model));
}));

test('a cancelled or interrupted attempt preserves the reason a source is paused', () => using((s, db, dir) => {
 const now = Date.now();
 const detail = { protocol: 2, model: 'p/m', reason: 'json_syntax' as const, field: 'memories[0].content' };
 s.capture(source());
 for (let i = 0; i < MAX_OUTPUT_FAILURES; i++) s.failEvolution(s.beginEvolution('s', true)!, 'invalid_output', now, detail);
 assert.equal(s.pausedJobs(), 1);
 assert.match(s.status(), /json_syntax/);
 // Shutdown/reload during a manual retry must not erase the explanation the user needs to repair it.
 s.failEvolution(s.beginEvolution('s', true, undefined, now, 'p/m')!, 'cancelled', now);
 assert.match(s.status(), /json_syntax/); assert.match(s.status(), /memories\[0\]\.content/);
 assert.equal(s.pausedJobs(), 1, 'a cancelled retry cannot silently unpause the source');
 // An expired lease recovered as interrupted keeps it too, and it survives reopen.
 s.beginEvolution('s', true, undefined, now, 'p/m');
 s.recoverExpired(now + EVOLUTION_TIMEOUT_MS + LEASE_GRACE_MS + 1);
 assert.match(s.status(), /json_syntax/);
 const reopened = new MemoryStore(dir);
 try { assert.match(reopened.status(), /json_syntax/); } finally { reopened.close(); }
}));

test('a new failure reports one outcome instead of inheriting an older field path', () => using((s) => {
 const now = Date.now();
 s.capture(source());
 s.failEvolution(s.beginEvolution('s', true)!, 'invalid_output', now, { protocol: 2, model: 'p/m', reason: 'content_length', field: 'memories[3].content', actual: 3 });
 assert.match(s.status(), /memories\[3\]\.content/);
 s.failEvolution(s.beginEvolution('s', true)!, 'provider', now, { protocol: 2, model: 'p/m', reason: 'request_failed' });
 assert.match(s.status(), /request_failed/);
 assert.ok(!s.status().includes('memories[3].content'), 'a transport failure must not inherit a parse field path');
 assert.ok(!s.status().includes('content_length'));
}));
