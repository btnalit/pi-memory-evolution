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
	assert.ok(capThenFilter.every(m=>run.candidates.some(c=>c.id===m.id)),
		'every record the previous selection would have shown must still be shown');
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
