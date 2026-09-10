import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeMemory } from './pi-api.ts';

test('uses exact active model and Pi registry completion/auth, no secondary model config',async()=>{
	const model={id:'active-model',provider:'active-provider'};
	const signal=AbortSignal.timeout(1000);let calls=0;
	const registry={async complete(actual:unknown,context:any,options:any){assert.equal(this,registry);assert.equal(actual,model);assert.equal(options.signal,signal);assert.equal(options.apiKey,undefined);assert.equal(context.tools,undefined);assert.ok(!('maxTokens' in options),'a model declaring no limit gets no invented one');calls++;return {stopReason:'stop',content:[{type:'text',text:'{"memories":[]}'}]};}};
	const result=await completeMemory({model,modelRegistry:registry} as unknown as ExtensionContext,'system','input',signal);
	assert.equal(result.model,'active-provider/active-model');assert.equal(calls,1);
});
// A ceiling is spent on reasoning before any answer is written, so a ceiling of our own can leave a
// thinking model with nothing left to say. The model's own limit cannot: it is the most it could ever
// emit. Not every adapter substitutes a default for an omitted field, so it is sent, not left out.
test('the model\'s own ceiling is sent, never a smaller one of ours',async()=>{
	const sent=new Set<string>();
	for(const [model,expected] of [[{id:'small',provider:'test',maxTokens:4096},4096],
		[{id:'big',provider:'test',maxTokens:200000},200000],[{id:'none',provider:'test'},undefined],
		[{id:'bad',provider:'test',maxTokens:0},undefined],[{id:'nan',provider:'test',maxTokens:1.5},undefined]] as const){
		// 'maxTokens' in options, not options.maxTokens: a key present but holding undefined would
		// otherwise read as absent, and some adapters treat a present key differently from a missing one.
		let seen:unknown='unset';
		const ctx={model,modelRegistry:{complete:async(_model:unknown,_context:unknown,options:any)=>{
			seen='maxTokens' in options?options.maxTokens:undefined;
			if('maxTokens' in options)sent.add(model.id);
			return {stopReason:'stop',content:[{type:'text',text:'{"memories":[]}'}]};
		}}};
		await completeMemory(ctx as unknown as ExtensionContext,'system','input',AbortSignal.timeout(1000));
		assert.equal(seen,expected,`wrong ceiling for ${model.id}`);
		assert.equal(sent.has(model.id),expected!==undefined,`wrong field presence for ${model.id}`);
	}
});
test('reasoning tokens are recorded, so a starved answer can be told from a broken model',async()=>{
	const usage={input:10,output:7023,cacheRead:0,cacheWrite:0,reasoning:6426};
	const ctx={model:{id:'t',provider:'p'},modelRegistry:{complete:async()=>({stopReason:'stop',usage,content:[{type:'text',text:'{"memories":[]}'}]})}};
	const result=await completeMemory(ctx as unknown as ExtensionContext,'system','input',AbortSignal.timeout(1000));
	assert.equal(result.diagnostic?.outputTokens,7023);
	assert.equal(result.diagnostic?.reasoningTokens,6426);
});
test('a provider that reports no reasoning breakdown leaves the field absent',async()=>{
	const usage={input:10,output:200,cacheRead:0,cacheWrite:0};
	const ctx={model:{id:'t',provider:'p'},modelRegistry:{complete:async()=>({stopReason:'stop',usage,content:[{type:'text',text:'{"memories":[]}'}]})}};
	const result=await completeMemory(ctx as unknown as ExtensionContext,'system','input',AbortSignal.timeout(1000));
	assert.equal(result.diagnostic?.outputTokens,200);
	assert.ok(!('reasoningTokens' in result.diagnostic!));
});
test('truncation and error responses expose fixed codes, not provider bodies',async()=>{
	for(const [stopReason,code] of [['length','output_limit'],['error','provider']]){
		const ctx={model:{id:'test',provider:'test'},modelRegistry:{complete:async()=>({stopReason,errorMessage:'private-secret',content:[]})}};
		await assert.rejects(completeMemory(ctx as unknown as ExtensionContext,'system','input',AbortSignal.timeout(1000)),(error:any)=>error.code===code&&!error.message.includes('private-secret'));
	}
});
test('model switching during completion cannot rewrite provenance',async()=>{
	const original={id:'original',provider:'provider-a'};
	const ctx={model:original,modelRegistry:{complete:async()=>{
		Object.defineProperty(ctx,'model',{get:()=>{throw new Error('context invalidated');}});
		return {stopReason:'stop',content:[{type:'text',text:'{"memories":[]}'}]};
	}}};
	const result=await completeMemory(ctx as unknown as ExtensionContext,'system','input',AbortSignal.timeout(1000));
	assert.equal(result.model,'provider-a/original');
});
test('missing model/old registry and truncated output fail instead of selecting an arbitrary provider',async()=>{
	for(const ctx of [{model:undefined},{model:{},modelRegistry:{}},{model:{},modelRegistry:{complete:async()=>({stopReason:'length',content:[]})}}])await assert.rejects(completeMemory(ctx as unknown as ExtensionContext,'system','input',AbortSignal.timeout(1000)));
});
