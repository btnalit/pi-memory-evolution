import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './memory-store.ts';
import { Database } from './sqlite.ts';

const source = (id: string) => ({id,scope:'/fixture',kind:'user' as const,content:'Remember Atlas uses SQLite.',createdAt:new Date().toISOString()});
test('different sources/providers in four processes share one atomic request slot', async () => {
 let dir: string | undefined;
 try {
  dir = mkdtempSync(join(tmpdir(),'pme-budget-processes-'));
  writeFileSync(join(dir,'recovery.json'),JSON.stringify({callsPerHour:1}));
  const s = new MemoryStore(dir); for (let i=0;i<4;i++) s.capture(source(`s${i}`)); s.close();
  const results = await Promise.all(Array.from({length:4},async (_,i) => {
   const code = `import {MemoryStore} from ${JSON.stringify(new URL('./memory-store.ts',import.meta.url).href)};const s=new MemoryStore(${JSON.stringify(dir)});console.log(s.beginEvolution('s${i}',true,undefined,Date.now(),'p${i}/model')?1:0);s.close();`;
   const result = await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{timeout:10000});
   return Number(result.stdout.trim());
  }));
  assert.equal(results.reduce((a,b)=>a+b,0),1);
  const db = new Database(join(dir,'memory.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_calls').get()!.n,1); }
  finally { db.close(); }
 } finally { if (dir) rmSync(dir,{recursive:true,force:true}); }
});

test('cancelling/reopening does not re-arm the single format correction', () => {
 let dir: string | undefined, s: MemoryStore | undefined;
 try {
  dir = mkdtempSync(join(tmpdir(),'pme-correction-'));
  s = new MemoryStore(dir);
  s.capture(source('s'));
  s.failEvolution(s.beginEvolution('s',true,undefined,Date.now(),'p/m')!,'invalid_output');
  const correction = s.beginEvolution('s',true,undefined,Date.now(),'p/m')!;
  assert.equal(correction.correctOutput,true); s.failEvolution(correction,'cancelled');
  const reopened = new MemoryStore(dir);
  try {
   const next = reopened.beginEvolution('s',true,undefined,Date.now(),'p/m')!;
   assert.equal(next.correctOutput,false); reopened.failEvolution(next,'cancelled');
  } finally { reopened.close(); }
 } finally { s?.close(); if (dir) rmSync(dir,{recursive:true,force:true}); }
});
