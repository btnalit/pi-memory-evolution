import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, ModelRegistry, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeMemory } from './pi-api.ts';

test('real Pi registry captures failed HTTP status, safe error codes and Retry-After without hidden retries', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'pme-http-'));
 let status = 401, errorCode = '', requests = 0;
 const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain synthetic request */ }
  requests++;
  assert.equal(req.headers.authorization, 'Bearer synthetic-key');
  res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '60' });
  res.end(JSON.stringify({ error: { code: errorCode, message: 'private-secret must never escape', type: 'test_error' } }));
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { 'fixture-http': { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'synthetic-key', models: [{ id: 'fixture', maxTokens: 1024 }] } } }));
  const runtime = await ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'cache.json'), refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const ctx = { model: registry.find('fixture-http', 'fixture'), modelRegistry: registry } as ExtensionContext;
  const cases = [[401, '', 'auth'], [403, '', 'auth'], [400, '', 'request'], [429, '', 'rate_limit'], [503, '', 'provider'],
   [429, 'insufficient_quota', 'quota'], [400, 'context_length_exceeded', 'context_limit'], [400, 'content_policy_violation', 'safety']] as const;
  for (const [http, code, expected] of cases) {
   status = http; errorCode = code;
   await assert.rejects(completeMemory(ctx, 'Synthetic system', 'Synthetic input', AbortSignal.timeout(5000)), (e: any) => {
    assert.equal(e.code, expected); assert.equal(e.diagnostic.httpStatus, http); assert.equal(e.diagnostic.retryAfterMs, 60_000);
    assert.ok(!JSON.stringify(e).includes('private-secret')); return true;
   });
  }
  assert.equal(requests, cases.length);
 } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
