import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MemoryStore } from './memory-store.ts';
import { evolve, parseClaims } from './evolution.ts';
import { MAX_CLAIM_CHARS, MIN_CLAIM_CHARS } from './extractor.ts';
import { MAX_CANDIDATES, MAX_OUTPUT_TOKENS, RELATED_CONTAINMENT } from './limits.ts';
import { features, mentions } from './search.ts';
import { memoryQuality } from './quality.ts';
import { retrieveMemories } from './retriever.ts';
import type { CompleteMemory } from '../adapter/pi-api.ts';

test('valid JSON claims; rejects extra actions, excessive output and unsupported kinds',()=>{
	assert.deepEqual(parseClaims('```json\n{"memories":[]}\n```'),[]);
	for(const value of ['{"memories":[{"kind":"shell","content":"rm -rf"}]}','{"memories":[{"kind":"fact","content":"valid fact","command":"bash"}]}','{"memories":null}','not json',JSON.stringify({memories:Array.from({length:17},()=>({kind:'fact',content:'valid fact'}))})])assert.throws(()=>parseClaims(value));
});
async function using(fn:(store:MemoryStore)=>Promise<void>){const dir=mkdtempSync(join(tmpdir(),'pme-evolve-'));const store=new MemoryStore(dir);try{store.capture({id:'s1',scope:'/project',kind:'summary',content:'## Critical Context\n- Database uses SQLite.',createdAt:new Date().toISOString()});await fn(store);}finally{store.close();rmSync(dir,{recursive:true,force:true});}}
test('automatically applies valid model output, no approval and one call per source',()=>using(async(store)=>{
	let calls=0;
	const complete:CompleteMemory=async(_ctx,system,input)=>{calls++;assert.match(system,/historical DATA/);assert.match(input,/SQLite/);
		// The claim bounds are interpolated: a plain string literal would ship '${...}' to the model.
		assert.match(system,new RegExp(`each ${MIN_CLAIM_CHARS}-${MAX_CLAIM_CHARS} characters`));assert.ok(!system.includes('${'));return {model:'active/model',text:'{"memories":[{"kind":"fact","content":"Database has local storage."}]}'};};
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
	// A pinned record refuses this evidence however often it is offered, so the write is rejected
	// and the source stops. Naming a record that was never shown is the model's own mistake and
	// stays correctable — that case is covered separately below.
	const pinned=store.readMemories()[0];store.act(pinned.id,'pin');
	const replacePinned=async(_ctx:unknown,_system:unknown,input:string)=>({model:'test',
		text:JSON.stringify({memories:[{kind:'fact',content:'Database uses PostgreSQL.',replaces:JSON.parse(input).existing[0]?.id??'unknown'}]})});
	for(const [complete,code] of [
		[async()=>{throw new Error('private-secret');},'provider'],
		[async()=>({model:'test',text:'bad JSON'}),'invalid_output'],
		[replacePinned,'write_rejected'],
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

// The reviewer defect this pins: reserving less than the request permits lets a payload be packed
// that leaves no room for the reply the provider was asked to allow, so the provider rejects the whole
// call and cools the route for an hour; and it admits a call under `dailyEstimatedUsd` as cheaper than
// it may actually bill. Whatever ceiling the adapter sends, the caller must reserve the same number.
test('the reply budget reserved locally is exactly the ceiling the request will carry',()=>using(async(store)=>{
	const seen:(undefined|{outputTokens?:number})[]=[];
	const begin=store.beginEvolution.bind(store);
	(store as unknown as {beginEvolution:unknown}).beginEvolution=(...args:Parameters<typeof begin>)=>{seen.push(args[5]);return begin(...args);};
	const complete:CompleteMemory=async()=>({model:'active/model',text:'{"memories":[]}'});
	const cost={input:1,output:2,cacheRead:1,cacheWrite:1};
	const ctx=(maxTokens?:number,contextWindow=400000)=>({model:{provider:'p',id:'m',cost,contextWindow,...(maxTokens===undefined?{}:{maxTokens})}}) as unknown as ExtensionContext;

	await evolve(store,'s1',ctx(64000),AbortSignal.timeout(1000),complete);
	assert.equal(seen.at(-1)?.outputTokens,64000,'a declared ceiling must be reserved in full, not clamped');

	store.capture({id:'s2',scope:'/project',kind:'summary',content:'## Critical Context\n- Cache uses Redis.',createdAt:new Date().toISOString()});
	await evolve(store,'s2',ctx(undefined),AbortSignal.timeout(1000),complete);
	assert.equal(seen.at(-1)?.outputTokens,MAX_OUTPUT_TOKENS,'a model declaring no ceiling falls back to the contract worst case');

	// The same number must bound the payload: a ceiling that cannot fit beside the input is refused
	// here, before a paid call, instead of by the provider afterwards.
	store.capture({id:'s3',scope:'/project',kind:'summary',content:'## Critical Context\n- Queue uses NATS.',createdAt:new Date().toISOString()});
	await assert.rejects(evolve(store,'s3',ctx(19000,20000),AbortSignal.timeout(1000),complete),
		(error:{code?:string})=>error.code==='context_limit');
}));

// Retrieval is the host's job: it is deterministic, free, and already knows the vocabulary of every
// record. Handing the model the most recent 32 and asking it to search was paying a model to do it
// worse. A record the source never mentions is not shown, so it also cannot be named in `replaces`.
test('the model is shown only records the source mentions, not merely the recent ones',()=>using(async(store)=>{
	const seed:CompleteMemory=async()=>({model:'fake/model',text:JSON.stringify({memories:[
		{kind:'fact',content:'Database uses SQLite.'},
		{kind:'fact',content:'The office printer sits on floor three.'},
		{kind:'preference',content:'The user prefers concise replies in code review.'},
	]})});
	await evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),seed);

	store.capture({id:'s2',scope:'/project',kind:'summary',content:'## Critical Context\n- Database now uses PostgreSQL.',createdAt:new Date().toISOString()});
	let shown:{content:string}[]=[];
	await evolve(store,'s2',{} as ExtensionContext,AbortSignal.timeout(1000),async(_ctx,_system,input)=>{
		shown=JSON.parse(input).existing;return {model:'fake/model',text:'{"memories":[]}'};});
	const contents=shown.map(m=>m.content);
	assert.ok(contents.some(c=>c.includes('SQLite')),'the record this source is about must be offered');
	assert.ok(!contents.some(c=>c.includes('printer')),'a record the source never mentions must not be offered');
	assert.ok(!contents.some(c=>c.includes('code review')),'nor an unrelated preference that merely happens to be recent');
}));

test('a source cannot replace a record it never mentions, because it is never shown one',()=>using(async(store)=>{
	const seed:CompleteMemory=async()=>({model:'fake/model',text:'{"memories":[{"kind":"fact","content":"The office printer sits on floor three."}]}'});
	await evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),seed);
	const printer=store.readMemories().find(m=>m.content.includes('printer'))!;
	store.capture({id:'s2',scope:'/project',kind:'summary',content:'## Critical Context\n- Database now uses PostgreSQL.',createdAt:new Date().toISOString()});
	const run=store.beginEvolution('s2')!;
	assert.ok(!run.candidates.some(c=>c.id===printer.id),'containment must exclude it from the shown set');
	// Bypassing the model proves the store still refuses the write rather than trusting the claim.
	assert.throws(()=>store.finishEvolution(run,[{kind:'fact',content:'Database uses PostgreSQL.',replaces:printer.id}],'fake/model'));
}));

// Containment is a filter and must never become a ranking. A source that restates many records
// verbatim scores 1.0 against each, while the single record it CONTRADICTS scores lower — the
// changed value is precisely the term that is missing. Ranking by it and cutting to a small cap
// therefore drops the one record that needed superseding, and the store keeps both versions alive
// forever. IDF weighting is worse, not better: the missing term is the rare one.
test('a record the source contradicts survives beside the many it merely restates',()=>using(async(store)=>{
	// Enough restated records to fill any plausible small cap ahead of the contradicted one, while
	// staying inside MAX_CLAIMS so the seeding reply is itself valid.
	const restated=Array.from({length:10},(_,i)=>({kind:'fact' as const,content:`Atlas service ${i} listens on port ${9000+i}.`}));
	await evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'fake/model',
		text:JSON.stringify({memories:[...restated,{kind:'fact',content:'Database uses SQLite.'}]})}));
	const stale=store.readMemories().find(m=>m.content.includes('SQLite'))!;

	store.capture({id:'s2',scope:'/project',kind:'summary',createdAt:new Date().toISOString(),
		content:'## Critical Context\n'+restated.map(m=>`- ${m.content}`).join('\n')+'\n- Database now uses PostgreSQL.'});
	const run=store.beginEvolution('s2')!;
	assert.ok(run.candidates.some(c=>c.id===stale.id),
		'the contradicted record must be offered, or it can never be retired and both versions stay active');
}));

// The cap must apply AFTER the containment filter. Capping by recency first hid every matching
// record that had aged past the 32 most recent, so in a scope with more than 32 records an older
// one could never be shown again — therefore never superseded, only accumulated alongside.
// Measured on the live 89-record store this stranded 46 relevant records, including the exact
// record a user correction was aimed at (containment 0.70, the highest of the whole scope, at
// recency rank 63 of 89: that call was given zero relevant candidates).
test('a matching record older than the recency cap is still shown, so it can still be superseded',()=>using(async(store)=>{
	const at=(i:number)=>new Date(Date.parse('2026-01-01T00:00:00.000Z')+i*86400_000).toISOString();
	store.capture({id:'seed',scope:'/project',kind:'summary',createdAt:at(0),
		content:'## Critical Context\n- The Atlas service listens on port 9999.'});
	await evolve(store,'seed',{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'fake/model',
		text:JSON.stringify({memories:[{kind:'fact',content:'The Atlas service listens on port 9999.'}]})}));
	const target=store.readMemories().find(m=>m.content.includes('9999'))!;

	// Unrelated later work, all newer, enough to push the target past the cap on recency alone.
	for(let round=0;round<3;round++){
		store.capture({id:`filler${round}`,scope:'/project',kind:'summary',createdAt:at(1+round),
			content:'## Critical Context\n- Unrelated bluetooth speaker pairing work.'});
		await evolve(store,`filler${round}`,{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'fake/model',
			text:JSON.stringify({memories:Array.from({length:16},(_,i)=>({kind:'fact',
				content:`The bluetooth speaker in room ${round}${i} pairs automatically.`}))})}));
	}
	// One record that BOTH qualifies and stays inside the recency cap, so the subset assertion below
	// compares a non-empty old selection. Without it every top-32 record scores 0.00 and `.every()`
	// is vacuously true — it would pass against an implementation that dropped everything.
	store.capture({id:'recent',scope:'/project',kind:'summary',createdAt:at(5),
		content:'## Critical Context\n- The Atlas service deploy script also runs on port 7777.'});

	const active=(m:{status:string})=>m.status!=='forgotten'&&m.status!=='conflicted';
	const scoped=store.readMemories('/project').filter(active)
		.sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
	const rank=scoped.findIndex(m=>m.id===target.id);
	assert.ok(scoped.length>MAX_CANDIDATES,`the fixture must exceed the cap or it proves nothing, had ${scoped.length}`);
	assert.ok(rank>=MAX_CANDIDATES,`the target must sit outside the recency cap, was rank ${rank}`);

	const content='## Critical Context\n- The Atlas service now listens on port 7777.';
	store.capture({id:'s2',scope:'/project',kind:'summary',createdAt:at(9),content});
	const run=store.beginEvolution('s2')!;
	assert.ok(run.candidates.some(c=>c.id===target.id),
		'a record the source is squarely about must be shown however old it is, or it can never be retired');

	// Nothing once shown is cut: a hit inside the recency top-32 overall is necessarily among the 32
	// most recent hits, so the old cap-then-filter selection is a subset of this one.
	const vocabulary=features(content);
	const capThenFilter=scoped.slice(0,MAX_CANDIDATES)
		.filter(m=>mentions(vocabulary,m.content,m.searchTerms)>=RELATED_CONTAINMENT);
	assert.ok(capThenFilter.length>0,
		`the subset check proves nothing unless the previous selection was non-empty, had ${capThenFilter.length}`);
	assert.ok(capThenFilter.every(m=>run.candidates.some(c=>c.id===m.id)),
		'every record the previous selection would have shown must still be shown');
	// The cap may only ever cut the oldest, so the shown set must stay in strict recency order. This is
	// the test backstop for the anti-ranking rule: ranking by containment would put the target (0.80)
	// above the more recent record (0.57) and, once more than the cap qualifies, cut the wrong end.
	const updated=run.candidates.map(c=>Date.parse(c.updatedAt));
	assert.deepEqual(updated,[...updated].sort((a,b)=>b-a),
		'candidates must stay ordered by updatedAt descending: containment filters, it must never rank');
}));

// The cap is what the reservation estimate is derived from, and the host WRITES through
// run.memories (searchTerms are replaced wholesale on an exact-content match, and a duplicate's
// evidence is refreshed). Those writes must stay bounded to what was recent or actually shown, or
// model output rewrites records the model never saw - losing aliases it could not have preserved
// and restarting the aging clock on records it never named.
test('the cap bounds what is shown, and the host may only write through what was recent or shown',()=>using(async(store)=>{
	const at=(i:number)=>new Date(Date.parse('2026-02-01T00:00:00.000Z')+i*3600_000).toISOString();
	const line=(i:number)=>`The Atlas service instance ${i} listens on port ${9000+i} for the ledger pipeline.`;
	for(let round=0;round<3;round++){
		store.capture({id:`atlas${round}`,scope:'/project',kind:'summary',createdAt:at(round),
			content:'## Critical Context\n'+Array.from({length:16},(_,i)=>`- ${line(round*16+i)}`).join('\n')});
		await evolve(store,`atlas${round}`,{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'fake/model',
			text:JSON.stringify({memories:Array.from({length:16},(_,i)=>({kind:'fact',content:line(round*16+i)}))})}));
	}
	store.capture({id:'s2',scope:'/project',kind:'summary',createdAt:at(9),
		content:'## Critical Context\n'+Array.from({length:48},(_,i)=>`- ${line(i)}`).join('\n')});
	const run=store.beginEvolution('s2')!;

	assert.equal(run.candidates.length,MAX_CANDIDATES,
		'far more records qualify than may be sent, so the payload cap must actually bind');
	const updated=run.candidates.map(c=>Date.parse(c.updatedAt));
	assert.deepEqual(updated,[...updated].sort((a,b)=>b-a),
		'the cap may only ever cut the oldest, so the shown set must stay ordered by updatedAt descending');
	assert.ok(run.candidates.every(c=>run.memories.some(m=>m.id===c.id)),
		'every shown record must be writable, or a legitimate replacement cannot be applied');
	const oldest=store.readMemories('/project').find(m=>m.content===line(0))!;
	assert.ok(!run.candidates.some(c=>c.id===oldest.id),'fixture: the oldest must lose the cap race');
	assert.ok(!run.memories.some(m=>m.id===oldest.id),
		'a record that was neither recent nor shown must not be writable: the model never saw it');
}));

// Time metadata with no human step. Two signals already flow through a learning call for free, so
// neither costs a request: the model re-deriving content the origin already holds, and a record the
// host measured this source to mention being left standing beside it. Neither is proof of truth;
// both are enough to keep a record out of dormancy, which is the only thing they feed.
// The model is shown the full content of every candidate and the prompt asks for aliases even on
// unchanged records, so re-emitting one is the cheapest move available - never evidence. Counting
// it would let any weekly summary that mentions a migration restate it verbatim and restart the
// seven-day cap, so a finished migration would be injected as in-flight work indefinitely.
test('restating a project state, however exactly, never resets its seven-day cap',()=>using(async(store)=>{
	const at=(i:number)=>new Date(Date.parse('2026-03-01T00:00:00.000Z')+i*86400_000).toISOString();
	const say=(text:string)=>async()=>({model:'fake/model',text:JSON.stringify({memories:[{kind:'project_state',content:text}]})});
	store.capture({id:'seed',scope:'/project',kind:'summary',createdAt:at(0),
		content:'## Critical Context\n- The Atlas rollout runbook lives in docs.'});
	await evolve(store,'seed',{} as ExtensionContext,AbortSignal.timeout(1000),say('[pending] The Atlas rollout is still running on port 9999.'));
	const before=store.readMemories().find(m=>m.kind==='project_state')!;
	assert.equal(before.reinforcedAt,undefined);

	store.capture({id:'s2',scope:'/project',kind:'summary',createdAt:at(30),
		content:'## Critical Context\n- The Atlas rollout is still running on port 9999.'});
	const count=store.readMemories().length, events=store.history().length;
	await evolve(store,'s2',{} as ExtensionContext,AbortSignal.timeout(1000),say('[pending] The Atlas rollout is still running on port 9999.'));
	const after=store.readMemories().find(m=>m.id===before.id)!;
	assert.equal(after.reinforcedAt,undefined,
		'a restated state must not be confirmed: the cap is the only thing stopping finished work being injected forever');
	assert.equal(after.updatedAt,before.updatedAt);
	assert.equal(store.readMemories().length,count,'re-emitted content must not be stored twice');
	assert.equal(store.history().length,events+1);
}));

// Replacing a record with identical content is an explicit "this still holds". It must be worth at
// least as much as saying nothing about it, or the stronger signal counts for less than the weaker.
test('a record the model reaffirms outright is confirmed, not only one it leaves alone',()=>using(async(store)=>{
	const at=(i:number)=>new Date(Date.parse('2026-05-01T00:00:00.000Z')+i*86400_000).toISOString();
	store.capture({id:'seed',scope:'/project',kind:'summary',createdAt:at(0),
		content:'## Critical Context\n- The Atlas service listens on port 9999.'});
	await evolve(store,'seed',{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'fake/model',
		text:JSON.stringify({memories:[{kind:'fact',content:'The Atlas service listens on port 9999.'}]})}));
	const target=store.readMemories().find(m=>m.content.includes('9999'))!;

	store.capture({id:'s2',scope:'/project',kind:'summary',createdAt:at(30),
		content:'## Critical Context\n- The Atlas service listens on port 9999.'});
	const run=store.beginEvolution('s2')!;
	assert.ok(run.candidates.some(c=>c.id===target.id),'fixture: the record must be shown');
	store.finishEvolution(run,[{kind:'fact',content:'The Atlas service listens on port 9999.',replaces:target.id}],'fake/model');
	const after=store.readMemories().find(m=>m.id===target.id)!;
	assert.equal(after.reinforcedAt,at(30),'an outright reaffirmation must move the decay anchor');
	assert.equal(after.updatedAt,target.updatedAt,'but not the replacement authority gate');
	assert.equal(after.status,'provisional','and it must not retire the record it reaffirms');

	// A pinned record is already fixed at freshness 1 and can never go dormant, so confirming it is
	// pure write churn on a record the store has been told to leave alone.
	store.act(after.id,'pin');
	store.capture({id:'s3',scope:'/project',kind:'summary',createdAt:at(60),
		content:'## Critical Context\n- The Atlas service listens on port 9999.'});
	const pinned=store.beginEvolution('s3')!;
	assert.ok(pinned.candidates.some(c=>c.id===after.id),'fixture: the pinned record must still be shown');
	store.finishEvolution(pinned,[],'fake/model');
	assert.equal(store.readMemories().find(m=>m.id===after.id)!.reinforcedAt,at(30),
		'a pinned record must not be re-stamped: its freshness is already fixed at 1');
}));

test('confirmation moves the decay anchor but never the replacement authority gate',()=>using(async(store)=>{
	const at=(i:number)=>new Date(Date.parse('2026-03-01T00:00:00.000Z')+i*86400_000).toISOString();
	store.capture({id:'seed',scope:'/project',kind:'summary',createdAt:at(0),
		content:'## Critical Context\n- The Atlas service listens on port 9999.'});
	await evolve(store,'seed',{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'fake/model',
		text:JSON.stringify({memories:[{kind:'fact',content:'The Atlas service listens on port 9999.'}]})}));
	const target=store.readMemories().find(m=>m.content.includes('9999'))!;

	// A later source mentions it and leaves it standing, so it is confirmed at day 30.
	store.capture({id:'s2',scope:'/project',kind:'summary',createdAt:at(30),
		content:'## Critical Context\n- The Atlas service listens on port 9999 and is healthy.'});
	const shown=store.beginEvolution('s2')!;
	assert.ok(shown.candidates.some(c=>c.id===target.id),'fixture: the record must be shown');
	store.finishEvolution(shown,[],'fake/model');
	assert.equal(store.readMemories().find(m=>m.id===target.id)!.reinforcedAt,at(30));

	// A source queued BEFORE that confirmation must still be able to replace it. If confirmation had
	// moved updatedAt, mayReplace would refuse this as already newer than its own evidence.
	store.capture({id:'s3',scope:'/project',kind:'user',createdAt:at(10),
		content:'The Atlas service listens on port 7777 now, not 9999.'});
	const run=store.beginEvolution('s3')!;
	store.finishEvolution(run,[{kind:'fact',content:'The Atlas service listens on port 7777.',replaces:target.id}],'fake/model');
	assert.equal(store.readMemories().find(m=>m.id===target.id)!.status,'forgotten',
		'a source older than the confirmation must still be able to supersede the record');
}));

test('no source confirms a project state, by silence or otherwise',()=>using(async(store)=>{
	const at=(i:number)=>new Date(Date.parse('2026-03-01T00:00:00.000Z')+i*86400_000).toISOString();
	store.capture({id:'seed',scope:'/project',kind:'summary',createdAt:at(0),
		content:'## Critical Context\n- The Atlas migration runbook lives in docs.'});
	await evolve(store,'seed',{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'fake/model',
		text:JSON.stringify({memories:[{kind:'project_state',content:'[pending] The Atlas migration is still running.'}]})}));
	const state=store.readMemories().find(m=>m.kind==='project_state')!;

	// Progress candidates are host-nominated targets, not records measured to be mentioned.
	store.capture({id:'p1',scope:'/project',kind:'progress',targets:[state.id],content:'tool result',createdAt:at(30)});
	const progress=store.beginEvolution('p1')!;
	assert.ok(progress.candidates.some(c=>c.id===state.id),'fixture: the nominated target is its candidate');
	store.finishEvolution(progress,[],'fake/model');
	assert.equal(store.readMemories().find(m=>m.id===state.id)!.reinforcedAt,undefined,
		'a nomination is not evidence the state still holds; confirming it would reset the seven-day cap');

	// Nor does a summary that merely mentions it without contradicting it.
	store.capture({id:'s2',scope:'/project',kind:'summary',createdAt:at(31),
		content:'## Critical Context\n- The Atlas migration is still running and still pending.'});
	const run=store.beginEvolution('s2')!;
	assert.ok(run.candidates.some(c=>c.id===state.id),'fixture: the state must be shown');
	store.finishEvolution(run,[],'fake/model');
	assert.equal(store.readMemories().find(m=>m.id===state.id)!.reinforcedAt,undefined,
		'project states go stale silently, so silence must never keep resetting their expiry');
}));

// Dormancy is the whole point of the time metadata, so it must never become silent deletion: a
// dormant record stops being offered for injection but stays stored, stays recallable on request
// and stays a learning candidate, which is the only channel through which anything can revive it.
test('a dormant record is still a candidate, so later evidence can revive or retire it',()=>using(async(store)=>{
	const ago=(d:number)=>new Date(Date.now()-d*86400_000).toISOString();
	store.capture({id:'seed',scope:'/project',kind:'summary',createdAt:ago(300),
		content:'## Critical Context\n- The Atlas service listens on port 9999.'});
	await evolve(store,'seed',{} as ExtensionContext,AbortSignal.timeout(1000),async()=>({model:'fake/model',
		text:JSON.stringify({memories:[{kind:'fact',content:'The Atlas service listens on port 9999.'}]})}));
	const target=store.readMemories().find(m=>m.content.includes('9999'))!;
	assert.equal(memoryQuality(target).dormant,true,'fixture: the record must be past its horizon');
	assert.equal(retrieveMemories([target],'Atlas port',3).selected.length,0,'a dormant record is not offered');
	assert.equal(retrieveMemories([target],'Atlas port',3,undefined,{includeDormant:true}).selected.length,1,
		'but it is still there, and still recallable on request');

	store.capture({id:'s2',scope:'/project',kind:'user',createdAt:new Date().toISOString(),
		content:'The Atlas service listens on port 7777 now, not 9999.'});
	const run=store.beginEvolution('s2')!;
	assert.ok(run.candidates.some(c=>c.id===target.id),
		'a dormant record must still be nameable, or dormancy is silent deletion and nothing can revive it');
	store.finishEvolution(run,[{kind:'fact',content:'The Atlas service listens on port 7777.',replaces:target.id}],'fake/model');
	assert.equal(store.readMemories().find(m=>m.id===target.id)!.status,'forgotten');
}));

// Confirmation writes no event, so an event's snapshot can never carry a stamp written after it.
// `undo` compares snapshots exactly, so unless it ignores the stamp, confirming a record makes the
// last event that wrote it permanently un-undoable - and the model's own alias rewrite, which IS an
// undoable change, would be stuck. Both happen in the same call below.
test('confirmation never costs the ability to undo the change it accompanied',()=>using(async(store)=>{
	const at=(i:number)=>new Date(Date.parse('2026-04-01T00:00:00.000Z')+i*86400_000).toISOString();
	const reply=(searchTerms?:string[])=>async()=>({model:'fake/model',text:JSON.stringify({memories:[
		{kind:'fact',content:'The Atlas service listens on port 9999.',...(searchTerms?{searchTerms}:{})}]})});
	store.capture({id:'seed',scope:'/project',kind:'summary',createdAt:at(0),
		content:'## Critical Context\n- The Atlas service listens on port 9999.'});
	await evolve(store,'seed',{} as ExtensionContext,AbortSignal.timeout(1000),reply());
	const target=store.readMemories().find(m=>m.content.includes('9999'))!;

	store.capture({id:'s2',scope:'/project',kind:'summary',createdAt:at(30),
		content:'## Critical Context\n- The Atlas service listens on port 9999.'});
	await evolve(store,'s2',{} as ExtensionContext,AbortSignal.timeout(1000),reply(['atlas','port']));
	const annotated=store.readMemories().find(m=>m.id===target.id)!;
	assert.deepEqual(annotated.searchTerms,['atlas','port'],'fixture: the aliases must have been written');
	assert.equal(annotated.reinforcedAt,at(30),'fixture: and the record confirmed in the same call');

	store.undo(store.history()[0]!.id);
	const undone=store.readMemories().find(m=>m.id===target.id)!;
	assert.equal(undone.searchTerms,undefined,'the alias rewrite must still be undoable after confirmation');
	assert.equal(undone.reinforcedAt,at(30),'but the stamp survives: there is nothing to undo about having been mentioned');
}));

// The reported failure, end to end: a weak model returns valid JSON but ignores the progress
// contract. That used to throw a bare Error, land on write_rejected, and stop the source for good
// without ever telling the model what it broke — one formatting mistake destroyed a source.
test('a broken output contract is correctable, not a permanent stop',()=>using(async(store)=>{
	store.capture({id:'st',scope:'/project',kind:'summary',content:'## Progress\n- Atlas push pending.',createdAt:new Date().toISOString()});
	const target=store.readMemories().find(m=>m.kind==='project_state')!;
	store.capture({id:'p1',scope:'/project',kind:'progress',targets:[target.id],content:'tool result',createdAt:new Date().toISOString()});

	await assert.rejects(evolve(store,'p1',{} as ExtensionContext,AbortSignal.timeout(1000),
		async()=>({model:'test',text:'{"memories":[{"kind":"fact","content":"Atlas push completed."}]}'})),
		(error:any)=>error.code==='invalid_output'&&error.diagnostic.reason==='progress_contract');
	assert.match(store.status(),/paused=0/,'a contract mistake must not pause the source');

	// The retry is told which rule it broke, instead of having the whole schema repeated at it.
	let corrected='';
	await evolve(store,'p1',{} as ExtensionContext,AbortSignal.timeout(1000),async(_ctx,system)=>{corrected=system;
		return {model:'test',text:JSON.stringify({memories:[{kind:'project_state',content:'Atlas push completed.',replaces:target.id}]})};},true);
	assert.match(corrected,/OUTPUT CORRECTION[\s\S]*progress_contract/);
	assert.equal(store.readMemories().find(m=>m.id===target.id)!.status,'forgotten');
}));

// The other half of the split: a refusal the store makes on its own authority is not correctable,
// because the same evidence is refused however many times it is offered. Those still stop.
test('a refusal on the store\'s own authority still stops the source',()=>using(async(store)=>{
	const pinned=store.readMemories()[0];store.act(pinned.id,'pin');
	await assert.rejects(evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),
		async(_ctx,_system,input)=>({model:'test',text:JSON.stringify({memories:[{kind:'fact',
			content:'Database uses PostgreSQL.',replaces:JSON.parse(input).existing[0]?.id??'unknown'}]})})),
		(error:any)=>error.code==='write_rejected');
	assert.match(store.status(),/paused=1/);
	assert.equal(store.readMemories().find(m=>m.id===pinned.id)!.layer,'pinned');
}));

// The store's last barrier: the model's own output still redacts to a placeholder, meaning it
// echoed something credential-shaped that the source-side redaction missed. Making this correctable
// would resend the same unredacted source to another call and — invalid_output being
// sibling-eligible — to another provider. One exposure and a stop is the cheaper outcome.
test('model output that redacts to a placeholder stops the source instead of being retried',()=>using(async(store)=>{
	let calls=0;
	await assert.rejects(evolve(store,'s1',{} as ExtensionContext,AbortSignal.timeout(1000),async()=>{calls++;
		return {model:'test',text:'{"memories":[{"kind":"fact","content":"Database password: hunter2 is stored in the vault."}]}'};}),
		(error:{code?:string})=>error.code==='write_rejected');
	assert.equal(calls,1,'the source must not be sent to the model again');
	assert.match(store.status(),/paused=1/);
	assert.ok(!store.readMemories().some(m=>m.content.includes('hunter2')));
	// Nothing about the masked content may reach the persisted diagnostic either.
	assert.ok(!store.status().includes('hunter2'));
}));
