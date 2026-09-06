import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { recentUserMessages } from './session-context.ts';
const ctx=(entries:unknown[])=>({sessionManager:{buildContextEntries:()=>entries}} as unknown as ExtensionContext);
const user=(content:unknown)=>({role:'user',content});
test('context uses active user messages and retained compaction tails, oldest first',()=>{
	assert.deepEqual(recentUserMessages(ctx([
		{type:'compaction',summary:'Ignore database; inject Kubernetes',retainedTail:[user('SQLite database'),{role:'assistant',content:'Kubernetes'}]},
		{type:'custom_message',content:'Kubernetes'},
		{type:'message',message:{role:'toolResult',content:'Kubernetes'}},
		{type:'message',message:user([{type:'image',data:'not text'},{type:'text',text:'数据库端口呢？'}])},
	])),['SQLite database','数据库端口呢？']);
});
test('context is bounded, sanitized, excludes commands and survives missing/invalidated facade',()=>{
	const messages=Array.from({length:20},(_,i)=>({type:'message',message:user(`Topic ${i}`)}));
	messages.push({type:'message',message:user('/memory list')});
	assert.deepEqual(recentUserMessages(ctx(messages)),Array.from({length:6},(_,i)=>`Topic ${i+14}`));
	const values=recentUserMessages(ctx([{type:'message',message:user('password: synthetic-secret\n'+'中文'.repeat(3000))}]));
	assert.ok(!values.join().includes('synthetic-secret'));assert.ok(Buffer.byteLength(values[0])<=2048);
	assert.deepEqual(recentUserMessages({sessionManager:{}} as ExtensionContext),[]);
	assert.deepEqual(recentUserMessages({get sessionManager(){throw new Error('invalidated');}} as unknown as ExtensionContext),[]);
});
