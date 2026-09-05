import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MemoryStore } from './memory-store.ts';
import { evolve, parseClaims } from './evolution.ts';
import type { CompleteMemory } from '../adapter/pi-api.ts';

test('valid JSON claims; rejects extra actions, excessive output and unsupported kinds',()=>{
	assert.deepEqual(parseClaims('```json\n{"memories":[]}\n```'),[]);
	for(const value of ['{"memories":[{"kind":"shell","content":"rm -rf"}]}','{"memories":[{"kind":"fact","content":"valid fact","command":"bash"}]}','{"memories":null}','not json',JSON.stringify({memories:Array.from({length:17},()=>({kind:'fact',content:'valid fact'}))})])assert.throws(()=>parseClaims(value));
});
async function using(fn:(store:MemoryStore)=>Promise<void>){const dir=mkdtempSync(join(tmpdir(),'pme-evolve-'));const store=new MemoryStore(dir);try{store.capture({id:'s1',scope:'/project',kind:'summary',content:'## Critical Context\n- Database uses SQLite.',createdAt:new Date().toISOString()});await fn(store);}finally{store.close();rmSync(dir,{recursive:true,force:true});}}
test('automatically applies valid model output, no approval and one call per source',()=>using(async(store)=>{
	let calls=0;
	const complete:CompleteMemory=async(_ctx,system,input)=>{calls++;assert.match(system,/historical DATA/);assert.match(input,/SQLite/);return {model:'active/model',text:'{"memories":[{"kind":"fact","content":"Database has local storage."}]}'};};
	assert.equal(await evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),complete),true);
	assert.equal(await evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),complete),false);
	assert.equal(calls,1);assert.equal(store.readMemories().length,2);assert.match(store.history()[0].reason,/active\/model/);
}));
test('invalid completion never partially applies changes; local fallback remains',()=>using(async(store)=>{
	await assert.rejects(evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'test',text:'not JSON'})));
	assert.equal(store.readMemories().length,1);assert.match(store.status(),/failed=1/);
}));
test('abort bounds providers that ignore AbortSignal and prevents late writes',()=>using(async(store)=>{
	let finish: ((result:{model:string;text:string})=>void) | undefined;
	const controller=new AbortController();
	const pending=evolve(store,'s1',{} as ExtensionContext,controller.signal,()=>new Promise((resolve)=>{finish=resolve;}));
	controller.abort();await assert.rejects(pending);
	finish!({model:'late',text:'{"memories":[{"kind":"fact","content":"Late invented fact."}]}'});
	await new Promise((resolve)=>setImmediate(resolve));assert.equal(store.readMemories().length,1);
}));
