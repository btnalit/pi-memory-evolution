import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeMemory } from './pi-api.ts';

test('uses exact active model and Pi registry completion/auth, no secondary model config',async()=>{
	const model={id:'active-model',provider:'active-provider'};
	const signal=AbortSignal.timeout(1000);let calls=0;
	const registry={async complete(actual:unknown,context:any,options:any){assert.equal(this,registry);assert.equal(actual,model);assert.equal(options.signal,signal);assert.equal(options.apiKey,undefined);assert.equal(context.tools,undefined);assert.equal(options.maxTokens,2048);calls++;return {stopReason:'stop',content:[{type:'text',text:'{"memories":[]}'}]};}};
	const result=await completeMemory({model,modelRegistry:registry} as unknown as ExtensionContext,'system','input',signal);
	assert.equal(result.model,'active-provider/active-model');assert.equal(calls,1);
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
