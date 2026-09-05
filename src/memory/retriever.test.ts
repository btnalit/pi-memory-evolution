import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRelevantMemories, terms, excerpt } from "./retriever.ts";
import type { DurableMemory } from "./memory-store.ts";
const now=Date.parse('2026-09-05T00:00:00Z');
const memory=(id:string,content:string,patch:Partial<DurableMemory>={}):DurableMemory=>({id,content,kind:'fact',scope:'/project',sourceEntryId:'s1',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',revision:1,layer:'durable',status:'provisional',...patch});
test('CJK topics outrank generic configuration',()=>{
	const result=selectRelevantMemories([memory('generic','保持人工批准，不修改配置。'),memory('audio','蓝牙音响优先使用 USB。')],'继续配置蓝牙音响',3,now);
	assert.equal(result[0].id,'audio');
});
test('CJK terms do not cross punctuation',()=>assert.deepEqual(selectRelevantMemories([memory('a','蓝牙。音响配置')],'牙音',3,now),[]));
test('unrelated prompt does not recall; continuation falls back to newest',()=>{
	const records=[memory('a','Older database state.'),memory('b','More recent network state.',{updatedAt:'2026-09-04T00:00:00Z'})];
	assert.deepEqual(selectRelevantMemories(records,'sorting algorithm',3,now),[]);
	assert.equal(selectRelevantMemories(records,'继续上次',3,now)[0].id,'b');
	assert.deepEqual(selectRelevantMemories(records,'resumeworthy',3,now),[]);
});
test('suppresses forgotten/conflicted/stale project state; deduplicates claims',()=>{
	const records=[memory('a','Database port is 5432.'),memory('b','Database port is 5432.'),memory('c','Database other.',{status:'forgotten'}),memory('d','Database other.',{status:'conflicted'}),memory('e','Database old task.',{kind:'project_state',updatedAt:'2020-01-01T00:00:00Z'})];
	assert.equal(selectRelevantMemories(records,'Database',3,now).length,1);
});
test('pinned context wins ties, date comparisons use numeric timestamps',()=>{
	assert.equal(selectRelevantMemories([memory('a','Database port.'),memory('b','Database port.',{layer:'pinned'})],'Database',1,now)[0].id,'b');
	assert.equal(selectRelevantMemories([memory('a','First unrelated.',{updatedAt:'2026-09-05T01:00:00+02:00'}),memory('b','Second unrelated.',{updatedAt:'2026-09-05T00:00:00Z'})],'resume',1,now)[0].id,'b');
});
test('tokenizes identifiers without changing their literal content',()=>{
	for(const token of ['foo_bar','foo','bar','camel','case'])assert.ok(terms('foo_bar camelCase').has(token));
});
test('excerpt preserves matched later sentence within UTF8 budget',()=>{
	const text='无关内容'.repeat(80)+'。蓝牙音响已配置。';
	const result=excerpt(text,'蓝牙音响',100);assert.match(result,/蓝牙音响/);assert.ok(Buffer.byteLength(result)<=100);
});
