import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeMemory } from './pi-api.ts';

test('uses exact active model and Pi registry completion/auth, no secondary model config',async()=>{
	const model={id:'active-model',provider:'active-provider'};
	const signal=AbortSignal.timeout(1000);let calls=0;
	const registry={async complete(actual:unknown,context:any,options:any){assert.equal(this,registry);assert.equal(actual,model);assert.equal(options.signal,signal);assert.equal(options.apiKey,undefined);assert.equal(context.tools,undefined);assert.equal(options.maxTokens,8192);calls++;return {stopReason:'stop',content:[{type:'text',text:'{"memories":[]}'}]};}};
	const result=await completeMemory({model,modelRegistry:registry} as unknown as ExtensionContext,'system','input',signal);
	assert.equal(result.model,'active-provider/active-model');assert.equal(calls,1);
});
test('output budget respects a smaller model limit',async()=>{
	const model={id:'small',provider:'test',maxTokens:4096};
	const ctx={model,modelRegistry:{complete:async(_model:unknown,_context:unknown,options:any)=>{
		assert.equal(options.maxTokens,4096);return {stopReason:'stop',content:[{type:'text',text:'{"memories":[]}'}]};
	}}};
	await completeMemory(ctx as unknown as ExtensionContext,'system','input',AbortSignal.timeout(1000));
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
