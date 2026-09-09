import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, ModelRegistry, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MemoryStore } from '../memory/memory-store.ts';
import { evolveRouted } from '../memory/scheduler.ts';
import { completeMemory } from './pi-api.ts';

const credentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };

test('real HTTP quota response switches to another Pi provider with its own auth, not a sibling model', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'pme-fallback-http-'));
 const calls: string[] = [];
 const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); calls.push(body.model);
  assert.ok(!body.tools?.length);
  if (req.url?.startsWith('/primary/')) {
   assert.equal(req.headers.authorization, 'Bearer synthetic-primary');
   res.writeHead(429, {'content-type':'application/json'});
   res.end(JSON.stringify({error:{code:'insufficient_quota',message:'private-secret'}}));
  } else {
   assert.equal(req.headers.authorization, 'Bearer synthetic-backup');
   res.writeHead(200, {'content-type':'text/event-stream'});
   const chunk = (delta: object, reason: string | null) => `data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:reason}]})}\n\n`;
   res.end(chunk({role:'assistant',content:'{"memories":[{"kind":"fact","content":"Atlas uses SQLite."}]}'},null) + chunk({},'stop') + 'data: [DONE]\n\n');
  }
 });
 await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
 const port = (server.address() as {port:number}).port;
 let s: MemoryStore | undefined;
 try {
  writeFileSync(join(dir,'models.json'),JSON.stringify({providers:{
   'fixture-primary':{baseUrl:`http://127.0.0.1:${port}/primary/v1`,api:'openai-completions',apiKey:'synthetic-primary',models:[{id:'primary'},{id:'sibling'}]},
   'fixture-backup':{baseUrl:`http://127.0.0.1:${port}/backup/v1`,api:'openai-completions',apiKey:'synthetic-backup',models:[{id:'backup'}]},
  }}));
  const runtime = await ModelRuntime.create({credentials,modelsPath:join(dir,'models.json'),modelsStorePath:join(dir,'catalog.json'),allowModelNetwork:false});
  const registry = new ModelRegistry(runtime), primary = registry.find('fixture-primary','primary')!;
  const ctx = {model:primary,modelRegistry:registry} as ExtensionContext;
  writeFileSync(join(dir,'recovery.json'),JSON.stringify({fallbackModels:['fixture-backup/backup']}));
  s = new MemoryStore(dir);
  s.capture({id:'fixture',kind:'user',scope:'/fixture',content:'Remember Atlas uses SQLite.',createdAt:new Date().toISOString()});
  assert.equal(await evolveRouted(s,'fixture',ctx,AbortSignal.timeout(5000)),true);
  assert.deepEqual(calls,['primary','backup']); assert.equal(ctx.model,primary);
  assert.equal(s.readMemories()[0].content,'Atlas uses SQLite.'); assert.match(s.history()[0].reason,/fixture-backup\/backup/);
  assert.ok(!s.status().includes('private-secret')); assert.match(s.status(),/quota/);
 } finally { s?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); rmSync(dir,{recursive:true,force:true}); }
});

test('Google SDK error JSON is decoded without injecting unsupported fetch or matching prose', async () => {
 const dir = mkdtempSync(join(tmpdir(),'pme-google-http-'));
 let calls = 0;
 const server = createServer(async (req,res) => {
  for await (const _ of req) { /* drain */ } calls++;
  res.writeHead(429,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'private-secret'}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const port = (server.address() as {port:number}).port;
  writeFileSync(join(dir,'models.json'),JSON.stringify({providers:{'fixture-google':{baseUrl:`http://127.0.0.1:${port}`,api:'google-generative-ai',apiKey:'synthetic-google',models:[{id:'gemini-fixture'}]}}}));
  const runtime = await ModelRuntime.create({credentials,modelsPath:join(dir,'models.json'),modelsStorePath:join(dir,'catalog.json'),allowModelNetwork:false,refreshOnCreate:false});
  const registry = new ModelRegistry(runtime), ctx = {model:registry.find('fixture-google','gemini-fixture'),modelRegistry:registry} as ExtensionContext;
  await assert.rejects(completeMemory(ctx,'Synthetic system','Synthetic input',AbortSignal.timeout(5000)),(e:any)=>{
   assert.equal(e.code,'rate_limit'); assert.equal(e.diagnostic.httpStatus,429); assert.ok(!JSON.stringify(e).includes('private-secret')); return true;
  });
  assert.equal(calls,1);
 } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(dir,{recursive:true,force:true}); }
});
