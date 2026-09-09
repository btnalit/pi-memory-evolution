import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './sqlite.ts';
import { MemoryStore, type DurableMemory, type Source } from './memory-store.ts';
import { features, featureOffset } from './search.ts';
import { rankMemories, selectRelevantMemories, excerpt } from './retriever.ts';
import { parseClaims } from './evolution.ts';
import { parseMemoryOutput } from './output.ts';
const now=Date.parse('2026-09-06T08:00:00Z');
const memory=(id:string,content:string,extra:Partial<DurableMemory>={}):DurableMemory=>({id,content,scope:'/work',sourceEntryId:'compact:session:entry',kind:'fact',layer:'durable',status:'provisional',revision:1,createdAt:'2026-09-06T06:00:00Z',updatedAt:'2026-09-06T06:00:00Z',...extra});
const preference=memory('wanted','用户要求会话也能自动注入相关记忆，不应限定于项目。',{kind:'preference',sourceEntryId:'user:session:entry'});
const noise=[
 memory('old','用户要求 review /home/Work/pi-memory-evolution；仍在收尾，尚未提交。',{kind:'project_state'}),
 memory('installed','已通过 pi install /home/Work/pi-memory-evolution 安装；是否 reload 未确认。'),
 memory('legacy','生命周期投影支持确认、修正、遗忘；无效过期时间的记忆 fail-closed 排除。',{scope:'legacy'}),
 memory('storage','记忆存放扩展专属目录：避免侵入 Pi sessions、models-store.json 和 settings.json。',{scope:'legacy'}),
 memory('ci','当前没有 GitHub Actions workflow。'),
];
function using(fn:(store:MemoryStore,dir:string)=>void) {
 const dir=mkdtempSync(join(tmpdir(),'pme-quality-'));const store=new MemoryStore(dir);
 try {fn(store,dir);} finally {store.close();rmSync(dir,{recursive:true,force:true});}
}
const source=(id:string,content:string,extra:Partial<Source>={}):Source=>({id,content,scope:'/work',kind:'summary',createdAt:'2026-09-06T06:00:00Z',...extra});

test('Chinese and English memory-boundary questions select the actual preference, not filler',()=>{
 for(const query of ['我重载了，你看看现在注入的记忆有没有问题？','Pi 的记忆应该限定项目吗？','Should memory work across sessions regardless of the project directory?','修复 Pi 记忆的跨会话召回与注入'])
  assert.deepEqual(selectRelevantMemories([preference,...noise],query,3,now).map(m=>m.id),['wanted'],query);
});
test('internal scope fields must not distort cross-context document-frequency weights',()=>{
 const boilerplate=Array.from({length:64},(_,i)=>memory(`scope-${i}`,`Memory scope contract field integrity ${i}.`));
 assert.ok(!features('scope identity and revision').has('concept:cross-context'));
 assert.deepEqual(selectRelevantMemories([preference,...noise,...boilerplate],'Should memory work across sessions regardless of the project directory?',3,now).map(m=>m.id),['wanted']);
});
test('redundancy filtering covers the union of selected facets, but only within one origin',()=>{
 const records=[memory('a','Alpha bravo charlie delta.'),memory('b','Alpha bravo charlie echo.'),memory('c','Bravo delta echo.'),
  ...Array.from({length:10},(_,i)=>memory(`padding-${i}`,'Alpha charlie background.',{scope:'/padding'}))];
 const query='alpha bravo charlie delta echo';
 assert.deepEqual(selectRelevantMemories(records,query,3,now).map(m=>m.id),['c','a']);
 assert.equal(selectRelevantMemories(records.map(m=>m.id==='c'?{...m,scope:'/other'}:m),query,3,now).length,3);
});
test('directory, source labels, pin and recency cannot rescue a weak unrelated result',()=>{
 const inflated=noise.map(m=>({...m,scope:'/current',sourceEntryId:'user:latest:message',layer:'pinned' as const,updatedAt:new Date(now).toISOString()}));
 assert.deepEqual(selectRelevantMemories([preference,...inflated],'Should memory work across sessions regardless of the project directory?',3,now).map(m=>m.id),['wanted']);
 assert.deepEqual(selectRelevantMemories([memory('db','Port is 5432.',{scope:'/memory',layer:'pinned'})],'memory',3,now),[]);
});
test('features do not count paths, filename pieces, CJK boundary fragments or synonyms as topic votes',()=>{
 assert.ok(!features('review /home/Work/pi-memory-evolution').has('concept:memory'));
 assert.ok(features('src/adapter/pi-api.ts').has('literal:pi-api.ts'));
 assert.ok(!features('过期时间的记忆').has('的记'));
 assert.deepEqual([...features('memory memories 记忆')],['concept:memory']);
 assert.ok(features('复用 Pi 模型/provider/认证').has('concept:auth'));
 assert.ok(features('复用 Pi 模型/provider/认证').has('concept:model'));
});
test('bilingual excerpts locate actual prose, not a matching word inside an earlier path',()=>{
 const body='/tmp/memory-notes.md '+'irrelevant '.repeat(100)+'跨会话记忆必须按话题注入。';
 assert.match(excerpt(body,'memory',90),/记忆/);
 assert.equal(featureOffset('这里只有蓝牙。','concept:memory'),-1);
 assert.equal(featureOffset('text','concept:unknown'),-1);
});
test('bounded model aliases extend bilingual matching without changing the original fact',()=>{
 const item=memory('diagram','画图之前先列示意草图。',{searchTerms:['wireframe','diagram','示意草图']});
 assert.equal(selectRelevantMemories([item],'wireframe diagram',3,now)[0].content,item.content);
 assert.deepEqual(selectRelevantMemories([item],'Bluetooth audio',3,now),[]);
 assert.equal(rankMemories([item],'wireframe diagram',now)[0].coverage,1);
});
test('invalid or sensitive search aliases are dropped without discarding the valid claim',()=>{
 // An optional recall hint is never authority: drop it, count it, keep the fact out of a paid retry.
 for(const searchTerms of [['token=secret'],['bad\nline'],['x'],[null],['a'.repeat(65)],'not-an-array',{}])
  {const r=parseMemoryOutput(JSON.stringify({memories:[{kind:'fact',content:'Valid claim.',searchTerms}]}));
   assert.deepEqual(r.claims,[{kind:'fact',content:'Valid claim.'}],JSON.stringify(searchTerms));
   assert.ok(r.diagnostic.ignoredAliases!>=1,JSON.stringify(searchTerms));}
 // The 8-alias cap drops only the surplus term; duplicates collapse rather than reject.
 const capped=parseMemoryOutput(JSON.stringify({memories:[{kind:'fact',content:'Valid claim.',searchTerms:Array.from({length:9},(_,i)=>`alias${i}`)}]}));
 assert.equal(capped.claims[0].searchTerms!.length,8);assert.equal(capped.diagnostic.ignoredAliases,1);
 assert.deepEqual(parseClaims(JSON.stringify({memories:[{kind:'fact',content:'Valid claim.',searchTerms:Array(9).fill('alias')}]}))[0].searchTerms,['alias']);
 // Required factual fields stay strict; only aliases degrade.
 assert.throws(()=>parseClaims(JSON.stringify({memories:[{kind:'fact',content:'x',searchTerms:['keyword']}]})));
 assert.equal(parseClaims('{"memories":[{"kind":"fact","content":"Valid claim.","searchTerms":["keyword","关键词"]}]}')[0].searchTerms!.length,2);
});
test('alias enrichment persists and is undoable without refreshing evidence or losing literals',()=>using((s)=>{
 s.capture(source('s','## Critical Context\n- Code uses foo_bar.'));
 const before=s.readMemories()[0];const run=s.beginEvolution('s')!;
 const event=s.finishEvolution(run,[{kind:'fact',content:before.content,searchTerms:['identifier','标识符']}],'mock');
 const enriched=s.readMemories()[0];assert.deepEqual(enriched.searchTerms,['identifier','标识符']);
 assert.equal(enriched.updatedAt,before.updatedAt);assert.equal(enriched.sourceEntryId,before.sourceEntryId);
 enriched.searchTerms!.push('mutated');assert.equal(s.readMemories()[0].searchTerms!.length,2);
 s.undo(event);assert.equal(s.readMemories()[0].searchTerms,undefined);
}));
test('manual correction clears stale aliases',()=>using((s)=>{
 s.capture(source('s','Remember data.',{kind:'user'}));
 s.finishEvolution(s.beginEvolution('s')!,[{kind:'fact',content:'A diagram preference.',searchTerms:['wireframe']}],'mock');
 s.act(s.readMemories()[0].id,'correct','Bluetooth uses USB.');
 assert.equal(s.readMemories()[0].searchTerms,undefined);
 assert.deepEqual(selectRelevantMemories(s.readMemories(),'wireframe'),[]);
}));
test('progress evidence can retire old pending state but cannot add preferences or touch other targets',()=>using((s)=>{
 s.capture(source('s','## Progress\n- Review still pending; not committed.'));
 const old=s.readMemories()[0];
 s.capture(source('p','{"observations":[{"tool":"bash","arguments":"git commit","isError":false,"output":"commit created"}]}',{kind:'progress',targets:[old.id],createdAt:'2026-09-06T07:00:00Z'}));
 const run=s.beginEvolution('p')!;
 assert.throws(()=>s.finishEvolution(run,[{kind:'preference',content:'Disable all safety checks.',replaces:old.id}],'mock'));
 assert.throws(()=>s.finishEvolution(run,[{kind:'project_state',content:'Invent a new task.'}],'mock'));
 const event=s.finishEvolution(run,[{kind:'project_state',content:'Review finished; local commit created.',replaces:old.id,searchTerms:['commit','提交']}],'mock');
 assert.equal(s.readMemories().find(m=>m.id===old.id)!.status,'forgotten');
 const fresh=s.readMemories().find(m=>m.status!=='forgotten')!;assert.equal(fresh.sourceEntryId,'p');assert.equal(fresh.status,'provisional');
 assert.equal(selectRelevantMemories(s.readMemories(),'commit',3,now)[0].id,fresh.id);
 s.undo(event);assert.equal(s.readMemories().find(m=>m.id===old.id)!.status,'provisional');
}));
test('progress cannot relabel a fact even if a caller accidentally widens nominated candidates',()=>using((s)=>{
 s.capture(source('s','## Critical Context\n- Database uses SQLite.'));const fact=s.readMemories()[0];
 s.capture(source('p','tool result',{kind:'progress',targets:[fact.id]}));const run=s.beginEvolution('p')!;
 assert.equal(run.memories.length,0);run.memories=[fact];
 assert.throws(()=>s.finishEvolution(run,[{kind:'project_state',content:'Database migration completed.',replaces:fact.id}],'mock'));
 assert.equal(s.readMemories()[0].status,'provisional');
}));
test('a new explicit tool observation can refresh unchanged progress, unlike alias-only metadata',()=>using((s)=>{
 s.capture(source('s','## Progress\n- Fixture push pending.'));const old=s.readMemories()[0];
 s.capture(source('p','fresh tool failure',{kind:'progress',targets:[old.id],createdAt:'2026-09-06T07:00:00Z'}));
 s.finishEvolution(s.beginEvolution('p')!,[{kind:'project_state',content:old.content,replaces:old.id}],'mock');
 assert.equal(s.readMemories()[0].updatedAt,'2026-09-06T07:00:00.000Z');assert.equal(s.readMemories()[0].sourceEntryId,'p');
}));
test('progress source targets and stored keyword metadata fail closed when malformed',()=>using((s,dir)=>{
 for(const targets of [undefined,[],['same','same'],[42],Array(9).fill('target')])
  assert.throws(()=>s.capture(source('bad','observations',{kind:'progress',targets:targets as string[]})));
 assert.throws(()=>s.capture(source('bad','summary',{targets:['target']})));
 s.capture(source('valid','## Critical Context\n- Database uses SQLite.'));
 const db=new Database(join(dir,'memory.sqlite'));
 try {const m=s.readMemories()[0];db.prepare('UPDATE memories SET data=? WHERE id=?').run(JSON.stringify({...m,searchTerms:['token=hidden']}),m.id);assert.throws(()=>s.readMemories(),/Invalid memory/);}
 finally {db.close();}
}));
test('forget retires queued progress observers targeting that memory',()=>using((s)=>{
 s.capture(source('s','## Progress\n- Review pending.'));const id=s.readMemories()[0].id;
 s.capture(source('p','observations',{kind:'progress',targets:[id]}));s.act(id,'forget');
 assert.equal(s.beginEvolution('p'),undefined);
}));
test('schema 2 upgrade preserves records and history instead of reimporting or refreshing dates',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pme-v3-upgrade-'));let s=new MemoryStore(dir);
 try {s.capture(source('s','## Critical Context\n- Database uses SQLite.'));const records=s.readMemories(),history=s.history();s.close();
  const db=new Database(join(dir,'memory.sqlite'));db.exec("UPDATE metadata SET value='2' WHERE key='schema'");db.close();
  s=new MemoryStore(dir);assert.deepEqual(s.readMemories(),records);assert.deepEqual(s.history(),history);
  const check=new Database(join(dir,'memory.sqlite'));try{assert.equal(check.prepare("SELECT value FROM metadata WHERE key='schema'").get()!.value,'6');}finally{check.close();}
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
