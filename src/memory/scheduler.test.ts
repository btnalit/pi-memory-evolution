import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MemoryStore } from './memory-store.ts';
import { Database } from './sqlite.ts';
import { EvolutionError } from './recovery.ts';
import { evolveRouted, modelKey, routeCandidates } from './scheduler.ts';
import { loadRoutingPolicy } from './routing-policy.ts';

const model = (provider: string, id = 'model') => ({ provider, id, api: 'openai-completions', input: ['text'], reasoning: false,
 contextWindow: 128000, maxTokens: 8192, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } });
const primary = model('primary'), backup = model('backup');
const context = () => ({ model: primary, modelRegistry: { getAvailable: () => [model('primary','sibling'), backup] } }) as unknown as ExtensionContext;
const source = (id: string) => ({ id, scope: '/fixture', kind: 'user' as const, content: 'Remember Atlas uses SQLite.', createdAt: new Date().toISOString() });
async function using(fn: (s: MemoryStore, db: Database, dir: string) => Promise<void>, policy?: object) {
 // Setup inside the try: a throw here would otherwise skip cleanup and orphan the directory.
 let dir = '', s: MemoryStore | undefined, db: Database | undefined;
 try {
  dir = mkdtempSync(join(tmpdir(), 'pme-routing-'));
  if (policy) writeFileSync(join(dir, 'recovery.json'), JSON.stringify(policy));
  s = new MemoryStore(dir); db = new Database(join(dir, 'memory.sqlite'));
  s.capture(source('source'));
  await fn(s, db, dir);
 } finally { db?.close(); s?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); }
}
const signal = () => AbortSignal.timeout(5000);
const ok = (ctx: ExtensionContext) => ({ model: `${ctx.model!.provider}/${ctx.model!.id}`, text: '{"memories":[]}' });

test('default follows Pi; quota switches providers, never sibling models or the foreground setting', () => using(async (s, db, dir) => {
 const ctx = context(), calls: string[] = [];
 const complete = async (c: ExtensionContext) => {
  calls.push(c.model!.provider);
  if (c.model!.provider === 'primary') throw new EvolutionError('quota', { httpStatus: 429, errorClass: 'quota' });
  return ok(c);
 };
 assert.equal(await evolveRouted(s, 'source', ctx, signal(), complete), true);
 assert.deepEqual(calls, ['primary','backup']); assert.equal(ctx.model, primary);
 assert.match(s.history()[0].reason, /backup\/model/);
 assert.equal(db.prepare('SELECT calls FROM sources').get()!.calls, 2);
 const reopened = new MemoryStore(dir);
 try {
  reopened.capture(source('next'));
  await evolveRouted(reopened, 'next', ctx, signal(), complete);
  assert.deepEqual(calls, ['primary','backup','backup'], 'provider cooldown is shared across sources/reload');
 } finally { reopened.close(); }
}));

test('rate limits and authentication failures switch, safety and rejected writes do not', async () => {
 for (const code of ['rate_limit','auth','safety','write_rejected'] as const) await using(async s => {
  const calls: string[] = [];
  const run = evolveRouted(s, 'source', context(), signal(), async c => {
   calls.push(c.model!.provider);
   if (c.model!.provider === 'primary') throw new EvolutionError(code, { httpStatus: code === 'rate_limit' ? 429 : 403 });
   return ok(c);
  });
  if (['safety','write_rejected'].includes(code)) { await assert.rejects(run); assert.deepEqual(calls, ['primary']); }
  else { assert.equal(await run, true); assert.deepEqual(calls, ['primary','backup']); }
 });
});

test('one output correction, then one alternate model; no failed JSON is replayed', () => using(async (s, db) => {
 const calls: string[] = [], prompts: string[] = [];
 const complete = async (c: ExtensionContext, prompt: string) => {
  calls.push(c.model!.provider); prompts.push(prompt);
  return c.model!.provider === 'primary' ? { model: 'primary/model', text: 'private-malformed-output' } : ok(c);
 };
 await assert.rejects(evolveRouted(s, 'source', context(), signal(), complete));
 assert.deepEqual(calls, ['primary']);
 db.exec("UPDATE sources SET retry_at=0");
 assert.equal(await evolveRouted(s, 'source', context(), signal(), complete), true);
 assert.deepEqual(calls, ['primary','primary','backup']);
 assert.equal(prompts.filter(p => p.includes('OUTPUT CORRECTION')).length, 1);
 assert.ok(prompts.every(p => !p.includes('private-malformed-output')));
}));

test('per-attempt timeout leaves time for a backup, and late primary output cannot write', () => using(async (s, db) => {
 let late: ((r: {model: string; text: string}) => void) | undefined;
 const calls: string[] = [];
 const complete = (c: ExtensionContext) => {
  calls.push(c.model!.provider);
  return c.model!.provider === 'primary' ? new Promise<{model: string; text: string}>(resolve => { late = resolve; }) : Promise.resolve(ok(c));
 };
 // A stalled provider call holds a socket. This fixture's pending promise holds nothing, and
 // AbortSignal.timeout is unref'd, so without a real handle the loop drains before the deadline.
 const stalled = setInterval(() => {}, 50);
 try {
  await assert.rejects(evolveRouted(s, 'source', context(), signal(), complete, false, 15), (e: any) => e.code === 'timeout');
  db.exec('UPDATE sources SET retry_at=0');
  assert.equal(await evolveRouted(s, 'source', context(), signal(), complete, false, 15), true);
  late!({ model: 'primary/model', text: '{"memories":[{"kind":"fact","content":"Invented late result."}]}' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['primary','primary','backup']); assert.equal(s.readMemories().length, 0);
 } finally { clearInterval(stalled); }
}));

test('model waits do not poison source backoff; cancellation does not add failures', () => using(async (s, db) => {
 const run = s.beginEvolution('source', 'auto', undefined, Date.now(), 'primary/model')!;
 s.failEvolution(run, 'rate_limit', Date.now(), { retryAfterMs: 3_600_000 });
 assert.equal(s.beginEvolution('source', 'auto', undefined, Date.now(), 'primary/model'), undefined);
 const other = s.beginEvolution('source', 'auto', undefined, Date.now(), 'backup/model');
 assert.ok(other); s.failEvolution(other, 'cancelled');
 assert.equal(db.prepare('SELECT failures FROM sources').get()!.failures, 1);
 assert.equal(s.routeAvailable('primary/model', 'primary'), false, 'the rate-limited model itself waits');
 assert.equal(s.routeAvailable('primary/sibling', 'primary'), true, 'a sibling keeps its own tpm/rpm budget');
 // Credentials and account quota are provider-wide, so those still park every sibling.
 s.failEvolution(s.beginEvolution('source', true, undefined, Date.now(), 'primary/model')!, 'quota');
 assert.equal(s.routeAvailable('primary/sibling', 'primary'), false);
}));

test('hard shared ceiling includes fallback/manual calls, across independent connections', () => using(async (s, db, dir) => {
 s.failEvolution(s.beginEvolution('source', true, undefined, Date.now(), 'primary/model')!, 'quota');
 const other = new MemoryStore(dir);
 try {
  assert.equal(other.beginEvolution('source', true, undefined, Date.now(), 'backup/model'), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_calls').get()!.n, 1);
 } finally { other.close(); }
}, { callsPerHour: 1 }));

test('source call/model/time limits persist without being reset by routing or restart', () => using(async (s, db, dir) => {
 s.failEvolution(s.beginEvolution('source', true, undefined, Date.now(), 'primary/model')!, 'provider');
 s.failEvolution(s.beginEvolution('source', true, undefined, Date.now(), 'backup/model')!, 'provider');
 const reopened = new MemoryStore(dir);
 try {
  assert.equal(reopened.beginEvolution('source', 'fallback', undefined, Date.now(), 'third/model'), undefined);
  db.exec('UPDATE sources SET retry_at=0,calls=4');
  assert.equal(reopened.pending(undefined, 'auto'), undefined);
  db.exec('UPDATE sources SET calls=2,call_ms=300000');
  assert.equal(reopened.pending(undefined, 'auto'), undefined);
 } finally { reopened.close(); }
}));

test('explicit allowlist/disable is honored without selecting unconfigured models', () => using(async s => {
 assert.deepEqual(routeCandidates(context(), s).map(m => m.provider), ['primary']);
}, { fallbackModels: ['unconfigured/model'] }));
test('cross-provider fallback can be disabled', () => using(async s => {
 assert.deepEqual(routeCandidates(context(), s).map(m => m.provider), ['primary']);
}, { crossProviderFallback: false }));

test('estimated USD ceiling rejects unknown pricing and is never bypassed manually', () => using(async s => {
 assert.equal(s.beginEvolution('source', true, undefined, Date.now(), 'primary/model'), undefined);
 assert.equal(s.beginEvolution('source', true, undefined, Date.now(), 'primary/model', { provider: 'primary', pricing: primary.cost }), undefined);
}, { dailyEstimatedUsd: 0.000001 }));

test('invalid policy fails closed, with no credentials in errors', () => {
 const dir = mkdtempSync(join(tmpdir(), 'pme-policy-'));
 try {
  for (const p of [{ sourceCalls: 9999 }, { callsPerHour: 0 }, { apiKey: 'private-secret' }, { crossProviderFallback: 'yes' }]) {
   writeFileSync(join(dir, 'recovery.json'), JSON.stringify(p));
   assert.throws(() => loadRoutingPolicy(dir), /^Error: Invalid recovery.json$/);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a same-provider sibling is never chosen automatically', () => using(async s => {
 // Siblings share the primary's credentials and account quota, so the automatic path stays cross-provider.
 assert.deepEqual(routeCandidates(context(), s).map(modelKey), ['primary/model', 'backup/model']);
}));

test('an explicit allowlist reaches a same-provider model, the only redundancy with one provider', () => using(async s => {
 // Previously this entry validated and was then silently dropped, leaving a single-provider host with no route.
 assert.deepEqual(routeCandidates(context(), s).map(modelKey), ['primary/model', 'primary/sibling']);
}, { fallbackModels: ['primary/sibling'] }));

test('a sibling absorbs model-specific limits but is skipped for shared quota and auth', async () => {
 for (const [code, routes] of [
  ['rate_limit', ['primary/model', 'primary/sibling']],
  ['quota', ['primary/model']],
  ['auth', ['primary/model']],
 ] as const) await using(async s => {
  const seen: string[] = [];
  const run = evolveRouted(s, 'source', context(), signal(), async c => {
   seen.push(modelKey(c.model!));
   if (modelKey(c.model!) === 'primary/model') throw new EvolutionError(code, { httpStatus: code === 'auth' ? 403 : 429 });
   return ok(c);
  });
  if (routes.length === 1) await assert.rejects(run); else assert.equal(await run, true);
  assert.deepEqual(seen, [...routes], `${code} routing`);
 }, { fallbackModels: ['primary/sibling'] });
});

test('an unenforceable cost ceiling is reported as blocked, never as available or as a deadline', () => using(async s => {
 const unpriced = { provider: 'local' };
 // Fail closed: an unknown price is not proof a call is free.
 assert.equal(s.beginEvolution('source', 'auto', undefined, Date.now(), 'local/model', unpriced), undefined);
 // The defect was the reporting, not the block: status claimed the budget was available while every
 // claim was refused, and the refusal renewed a 24h deadline that could never arrive.
 const text = s.budgetStatus('local/model', Date.now(), unpriced);
 assert.match(text, /blocked/); assert.match(text, /no catalog pricing/); assert.match(text, /recovery\.json/);
 assert.ok(!text.includes('available'), text);
 assert.ok(!text.includes('waiting until'), text);
 assert.equal(s.beginEvolution('source', 'auto', undefined, Date.now() + 3 * 86_400_000, 'local/model', unpriced), undefined,
  'waiting cannot make an unpriced model enforceable');
}, { dailyEstimatedUsd: 5 }));

const priced = { provider: 'primary', pricing: primary.cost };
const spend = (db: Database, at: number, usd: number, model = 'primary/model') =>
 db.prepare("INSERT INTO model_calls(source_id,attempt,model,provider,at,outcome,charged_usd) VALUES (?,1,?,?,?,'done',?)")
  .run(`c${at}${usd}`, model, model.split('/')[0], at, usd);

test('a call larger than the whole ceiling stays blocked even while other spend sits in the window', () => using(async (s, db) => {
 const now = Date.now();
 // Unrelated spend must not turn "never fits" into a deadline that only flips back to blocked once
 // that spend ages out. Nothing leaving the window makes this one call fit.
 spend(db, now - 23 * 3_600_000, 0.01, 'backup/model');
 const text = s.budgetStatus('primary/model', now, priced);
 assert.match(text, /blocked/);
 assert.ok(!text.includes('waiting until'), text);
}, { dailyEstimatedUsd: 0.001 }));

test('accumulated spend under the ceiling is a real wait the window can actually clear', () => using(async (s, db) => {
 const now = Date.now();
 assert.match(s.budgetStatus('primary/model', now, priced), /available/, 'one call alone fits this ceiling');
 spend(db, now, 0.99);
 const waiting = s.budgetStatus('primary/model', now, priced);
 assert.match(waiting, /waiting until/);
 assert.ok(!waiting.includes('blocked'), waiting);
}, { dailyEstimatedUsd: 1 }));

test('status without an active model reports what a claim would find, not an empty budget', () => using(async s => {
 // ctx.model can be absent, and beginEvolution then prices that call as unknown. Status asking a
 // different question — treating "no model" as free — is how it came to print the opposite before.
 const text = s.budgetStatus('primary/model', Date.now());
 assert.match(text, /blocked/);
 assert.ok(!/budget: available/.test(text), text);
}, { dailyEstimatedUsd: 5 }));
