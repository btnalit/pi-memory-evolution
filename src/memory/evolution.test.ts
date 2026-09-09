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
test('large valid bilingual output fits the new byte budget while oversized output is rejected',()=>{
	const text=JSON.stringify({memories:Array.from({length:16},()=>({kind:'fact',content:'中'.repeat(480),searchTerms:Array.from({length:8},(_,i)=>`关键词${i}`+'中'.repeat(20))}))});
	assert.ok(Buffer.byteLength(text)>24000);assert.equal(parseClaims(text).length,16);
	assert.throws(()=>parseClaims(' '.repeat(64001)),(e:any)=>e.code==='invalid_output'&&e.diagnostic.reason==='output_too_large');
});
test('provider, parse and transaction failures have distinct persisted categories',()=>using(async(store)=>{
	for(const [complete,code] of [
		[async()=>{throw new Error('private-secret');},'provider'],
		[async()=>({model:'test',text:'bad JSON'}),'invalid_output'],
		[async()=>({model:'test',text:'{"memories":[{"kind":"fact","content":"Valid but unauthorized fact.","replaces":"unknown"}]}'}),'write_rejected'],
	] as const){
		await assert.rejects(evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),complete,true),(error:any)=>error.code===code);
		assert.match(store.status(),new RegExp(code));assert.ok(!store.status().includes('private-secret'));
	}
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

test('the output correction note follows the actual previous failure, not a cumulative counter',()=>using(async(store)=>{
	const prompts:string[]=[];
	const ok:CompleteMemory=async(_ctx,system)=>{prompts.push(system);return {model:'test',text:'{"memories":[]}'};};
	const bad=(text:string):CompleteMemory=>async(_ctx,system)=>{prompts.push(system);return {model:'test',text};};
	const ctx={} as ExtensionContext, signal=()=>AbortSignal.timeout(1000);
	// A protocol failure earns one correction note carrying the fixed rule that failed, never the failed output.
	await assert.rejects(evolve(store,'s1',ctx,signal(),bad('{"memories":[{"kind":"fact"}]}'),true));
	await assert.rejects(evolve(store,'s1',ctx,signal(),bad('still not JSON'),true));
	assert.match(prompts.at(-1)!,/OUTPUT CORRECTION/);
	assert.match(prompts.at(-1)!,/content_type|memories\[0\]/);
	assert.ok(!prompts.at(-1)!.includes('{"memories":[{"kind":"fact"}]}'),'the failed output is never echoed back');
	// A later transport failure must not keep asserting that the previous attempt failed validation.
	await assert.rejects(evolve(store,'s1',ctx,signal(),async()=>{throw new Error('offline');},true));
	await evolve(store,'s1',ctx,signal(),ok,true);
	assert.ok(!prompts.at(-1)!.includes('OUTPUT CORRECTION'),'a provider error is not an output-validation failure');
}));
