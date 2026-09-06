import { test } from "node:test";
import assert from "node:assert/strict";
import { recallQuery, selectRelevantMemories, terms, excerpt } from "./retriever.ts";
import type { DurableMemory } from "./memory-store.ts";
const now=Date.parse('2026-09-05T00:00:00Z');
const memory=(id:string,content:string,patch:Partial<DurableMemory>={}):DurableMemory=>({id,content,kind:'fact',scope:'/project',sourceEntryId:'s1',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',revision:1,layer:'durable',status:'provisional',...patch});
test('CJK topics outrank generic configuration',()=>{
	const result=selectRelevantMemories([memory('generic','保持人工批准，不修改配置。'),memory('audio','蓝牙音响优先使用 USB。')],'继续配置蓝牙音响',3,now);
	assert.equal(result[0].id,'audio');
});
test('CJK terms do not cross punctuation',()=>assert.deepEqual(selectRelevantMemories([memory('a','蓝牙。音响配置')],'牙音',3,now),[]));
test('unrelated prompt and context-free continuation do not recall arbitrary recent records',()=>{
	const records=[memory('a','Older database state.'),memory('b','More recent network state.',{updatedAt:'2026-09-04T00:00:00Z'})];
	assert.deepEqual(selectRelevantMemories(records,'sorting algorithm',3,now),[]);
	assert.deepEqual(selectRelevantMemories(records,'继续上次',3,now),[]);
	assert.deepEqual(selectRelevantMemories(records,'resumeworthy',3,now),[]);
});
test('suppresses forgotten/conflicted/stale project state; deduplicates claims',()=>{
	const records=[memory('a','Database port is 5432.'),memory('b','Database port is 5432.'),memory('c','Database other.',{status:'forgotten'}),memory('d','Database other.',{status:'conflicted'}),memory('e','Database old task.',{kind:'project_state',updatedAt:'2020-01-01T00:00:00Z'})];
	assert.equal(selectRelevantMemories(records,'Database',3,now).length,1);
});
test('pinned context wins ties, date comparisons use numeric timestamps',()=>{
	assert.equal(selectRelevantMemories([memory('a','Database port.'),memory('b','Database port.',{layer:'pinned'})],'Database',1,now)[0].id,'b');
	assert.equal(selectRelevantMemories([memory('a','First unrelated.',{updatedAt:'2026-09-05T01:00:00+02:00'}),memory('b','Second unrelated.',{updatedAt:'2026-09-05T00:00:00Z'})],'unrelated',1,now)[0].id,'b');
});
test('actual reload question cannot match CI through the word 没有',()=>{
	const records=[memory('ci','当前没有 GitHub Actions workflow。'),memory('recall','记忆按话题自动注入。')];
	assert.deepEqual(selectRelevantMemories(records,'我重载了，你看看现在注入的记忆有没有问题？',3,now).map(m=>m.id),['recall']);
	for(const query of ['没有','现在的问题','the current configuration','配置'])assert.deepEqual(selectRelevantMemories(records,query,3,now),[]);
});
test('global recall preserves distinct origins, including old legacy records without adoption',()=>{
	const records=[memory('a','Database port is 5432.',{scope:'/Alpha'}),memory('b','Database port is 5432.',{scope:'/Beta'}),memory('old','Database uses SQLite.',{scope:'legacy'})];
	assert.equal(selectRelevantMemories(records,'Database',3,now,'/Elsewhere').length,3);
	assert.equal(selectRelevantMemories(records,'Alpha database port',1,now,'/Elsewhere')[0].id,'a');
	assert.deepEqual(selectRelevantMemories(records,'sorting algorithm',3,now,'/Alpha'),[]);
});
test('vague followups inherit only the nearest user topic, while topic switches stand alone',()=>{
	const history=['Discuss SQLite database configuration.','Now discuss Bluetooth audio.','这个有问题'];
	assert.match(recallQuery('继续',history),/Bluetooth/);
	assert.match(recallQuery('这个有问题，继续修复',history),/Bluetooth/);
	assert.equal(recallQuery('Kubernetes networking',history),'Kubernetes networking');
	assert.equal(recallQuery('继续 PostgreSQL 调优',history),'继续 PostgreSQL 调优');
	assert.equal(recallQuery('继续',[]),'');
	assert.equal(recallQuery('继续',['SQLite database','换个话题']),'');
	assert.equal(recallQuery('换个话题',history),'');
	assert.match(recallQuery('端口呢？',['SQLite 数据库端口设置']),/SQLite/);
});
test('resolved followups select the actual topic rather than the newest unrelated record',()=>{
	const records=[memory('db','SQLite database uses port 5432.'),memory('audio','Bluetooth audio uses USB.',{updatedAt:'2026-09-04T00:00:00Z'})];
	assert.deepEqual(selectRelevantMemories(records,recallQuery('继续',['SQLite database configuration']),3,now).map(m=>m.id),['db']);
	assert.deepEqual(selectRelevantMemories(records,recallQuery('Kubernetes networking',['SQLite database configuration']),3,now),[]);
});
test('tokenizes identifiers without changing their literal content',()=>{
	for(const token of ['foo_bar','foo','bar','camel','case'])assert.ok(terms('foo_bar camelCase').has(token));
});
test('excerpt finds English sentences and late matches in a long sentence',()=>{
	assert.match(excerpt('Unrelated detail. '.repeat(40)+'SQLite is ready.','SQLite',60),/SQLite/);
	assert.match(excerpt('🙂 '.repeat(100)+'camelNeedleCase remains literal.','needle',60),/Needle/);
	for(const budget of [0,1,2,3,4,5,6,20,60])assert.ok(Buffer.byteLength(excerpt('🙂 '.repeat(100)+'needle is here.','needle',budget))<=budget);
});
test('excerpt preserves matched later sentence within UTF8 budget',()=>{
	const text='无关内容'.repeat(80)+'。蓝牙音响已配置。';
	const result=excerpt(text,'蓝牙音响',100);assert.match(result,/蓝牙音响/);assert.ok(Buffer.byteLength(result)<=100);
});
