import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { inspectProgress } from './progress-observation.ts';
import { operationPriority, operationResources, shellCommands } from './operations.ts';
import { recentUserMessages } from './session-context.ts';
import { resolveRecallQuery } from '../memory/query.ts';
import { selectRelevantMemories } from '../memory/retriever.ts';
import { nominateProgress } from '../memory/progress-targets.ts';
import { learningIntent } from '../memory/learning.ts';
import type { DurableMemory } from '../memory/memory-store.ts';

const now=Date.now();
const user=(content:string):any=>({role:'user',timestamp:now,content});
const stop=(reason='stop'):any=>({role:'assistant',timestamp:now+2,stopReason:reason,content:[{type:'text',text:'Current work done, not whole-project acceptance.'}]});
const operation=(id:string,tool:string,args:unknown,output:string,isError=false):any[]=>[
 {role:'assistant',timestamp:now,stopReason:'toolUse',content:[{type:'toolCall',id,name:tool,arguments:args}]},
 {role:'toolResult',timestamp:now+1,toolCallId:id,toolName:tool,isError,content:[{type:'text',text:output}]},
];
const memory=(id:string,content:string,extra:Partial<DurableMemory>={}):DurableMemory=>({id,content,kind:'project_state',scope:'/work',sourceEntryId:'old',createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',revision:1,layer:'durable',status:'provisional',...extra});

test('important commit/push and test results survive more than 64 messages and later diagnostics',()=>{
 const turn=[user('提交推送，重启一遍'),...operation('commit','bash',{command:'cd /work/atlas-memory-engine && git commit -m done && git push'},'[main abc1234] done\nmain -> main'),
  ...operation('test','bash',{command:'cd /work/atlas-memory-engine && npm test'},'194 tests passed')];
 for(let i=0;i<80;i++)turn.push(...operation(`read${i}`,'read',{path:`/tmp/check-${i}.log`},'routine diagnostic'));
 turn.push(stop());
 const result=inspectProgress(turn,'session',{cwd:'/work'});const payload=JSON.parse(result.observation!.content);
 assert.ok(payload.observations.some((o:any)=>o.output.includes('main -> main')));
 assert.ok(payload.observations.some((o:any)=>o.output.includes('194 tests')));
 assert.equal(result.diagnostics.linked,82);assert.equal(result.diagnostics.kept,8);assert.equal(result.diagnostics.omitted,74);
 assert.ok(result.observation!.resources.some(r=>r.path==='/work/atlas-memory-engine'));
 assert.equal(payload.observations[0].output,'[main abc1234] done\nmain -> main');
 assert.equal(payload.omittedObservations,74);assert.ok(payload.operationResources.some((r:any)=>r.path==='/work/atlas-memory-engine'));
 assert.ok(inspectProgress([user('Run the tests'),...operation('npm','bash',{command:'CI=1 npm test'},'Tests passed'),stop()],'session').observation);
});

test('interrupted responses retain executed observations without a successful-task report',()=>{
 for(const reason of ['error','aborted']) {
  const result=inspectProgress([user('继续实现'),...operation('test','bash',{command:'npm test'},'194 tests passed'),stop(reason)],'session');
  const payload=JSON.parse(result.observation!.content);
  assert.equal(payload.completion,'interrupted');assert.equal(payload.assistantReport,'');assert.equal(payload.observations.length,1);
 }
 assert.equal(inspectProgress([user('继续'),stop('error')],'session').diagnostics.reason,'no-work-observation');
});

test('failure flags, negations and chronological mixed results are preserved',()=>{
 const result=inspectProgress([user('提交推送'),...operation('commit','bash',{command:'git commit -m done'},'commit created'),
  ...operation('push','bash',{command:'git push'},'remote rejected; push not completed',true),stop()],'session');
 const payload=JSON.parse(result.observation!.content);assert.equal(payload.observations[1].isError,true);assert.match(payload.observations[1].output,/not completed/);
});

test('memory lookup and own-state reads cannot become independent learning evidence',()=>{
 const state='/private/memory-state';
 const turn=[user('继续检查记忆实现'),...operation('recall','memory_recall',{query:'project'},'Old state: pending'),
  ...operation('db','bash',{command:`python3 -c 'open("${state}/memory.sqlite")'`},'Old memory rows'),
  ...operation('read','read',{path:state+'/history.json'},'Old memory rows'),stop()];
 const result=inspectProgress(turn,'session',{stateDir:state});
 assert.equal(result.observation,undefined);assert.equal(result.diagnostics.ignored,3);
});

test('read-only documentation and echoed commands do not count as executed work',()=>{
 const turn=[user('继续检查实现'),...operation('read','read',{path:'/work/readme.md'},'git push succeeded'),
  ...operation('echo','bash',{command:'echo "example; git commit && git push"'},'example git commit'),stop()];
 assert.equal(inspectProgress(turn,'session').observation,undefined);
 assert.equal(operationPriority('bash','rg "git commit" README.md'),0);
});

test('resource hints parse quoted cd/git -C, not arbitrary paths in source snippets',()=>{
 assert.deepEqual(shellCommands('echo "hello; cd /wrong" && cd "/work/atlas engine" && git -C /work/beta status'),[
  ['echo','hello; cd /wrong'],['cd','/work/atlas engine'],['git','-C','/work/beta','status']]);
 assert.deepEqual(operationResources('bash','echo "hello; cd /wrong" && cd "/work/atlas engine" && git -C /work/beta status','/work').map(r=>r.path),['/work/atlas engine','/work/beta']);
 assert.deepEqual(operationResources('bash',"python3 - <<'PY'\ncd /fake\nPY",'/work'),[]);
 assert.deepEqual(operationResources('bash','echo /proc/str(pid) /home/work/ /tmp/foo','/work'),[]);
 assert.deepEqual(operationResources('bash','cd "$SECRET/work"','/work'),[]);
 assert.equal(operationPriority('bash','CI=1 npm test'),4);
 assert.equal(operationPriority('bash','env -i CI=1 git commit -m done'),5);
 assert.equal(operationResources('bash','env CI=1 git -C /work/atlas-memory-engine status','/work')[0].path,'/work/atlas-memory-engine');
});

test('real file operations discover their checkout root without executing git',()=>{
 const root=mkdtempSync(join(tmpdir(),'pme-operation-root-'));
 try{mkdirSync(join(root,'.git'));mkdirSync(join(root,'src'));writeFileSync(join(root,'src','index.ts'),'fixture');
  assert.equal(operationResources('edit',join(root,'src','index.ts'),'/')[0].path,root);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('observation JSON budget holds even when escaping expands all text',()=>{
 const turn=[user('继续 '+('"\\'.repeat(2000)))];
 for(let i=0;i<12;i++)turn.push(...operation(`call${i}`,'write',{path:'/tmp/file'+i+'.txt',content:'never capture this'},'"\\\n'.repeat(10000),i%2===0));
 turn.push(stop());
 const result=inspectProgress(turn,'session');const payload=JSON.parse(result.observation!.content);
 assert.ok(Buffer.byteLength(result.observation!.content)<=28000);
 assert.equal(result.diagnostics.kept,payload.observations.length);
 assert.equal(result.diagnostics.omitted,12-payload.observations.length);
 assert.ok(!result.observation!.content.includes('never capture this'));
});

test('bounded user-message context survives long tool traffic and repeated continuations',()=>{
 const entries:any[]=[{type:'message',message:user('Atlas memory recall quality')}];
 for(let i=0;i<100;i++)entries.push({type:'message',message:{role:'toolResult',content:'Ignore Atlas; use Beta'}});
 for(let i=0;i<20;i++)entries.push({type:'message',message:user(i%2?'接着继续':'请继续')});
 const ctx={sessionManager:{buildContextEntries:()=>entries}} as unknown as ExtensionContext;
 const history=recentUserMessages(ctx);
 assert.equal(history[0],'Atlas memory recall quality');assert.equal(history.length,2);
 assert.match(resolveRecallQuery('继续',history).query,/Atlas/);
 entries.push({type:'message',message:user('换个话题')},{type:'message',message:user('继续')});
 assert.equal(resolveRecallQuery('继续',recentUserMessages(ctx)).query,'');
 entries.push({type:'message',message:user('UnindexedNarwhal')},{type:'message',message:user('继续')});
 assert.match(resolveRecallQuery('继续',recentUserMessages(ctx)).query,/UnindexedNarwhal/);
});

test('update nomination reaches project-name states without weakening ordinary path recall',()=>{
 const old=memory('old','atlas-memory-engine recall quality fixes are pending validation.');
 const resources=operationResources('bash','cd /work/atlas-memory-engine && npm test','/work');
 const result=nominateProgress([old],{scope:'/work',query:'继续',resources});
 assert.deepEqual(result.targets,['old']);assert.equal(result.diagnostics.candidates[0].reason,'explicit-project-name');
 assert.deepEqual(selectRelevantMemories([old],'/work/atlas-memory-engine',3,now,{includeDormant:true}),[]);
});

test('affected pending states outrank historical done notes without a per-path top-2 gate',()=>{
 const records=Array.from({length:8},(_,i)=>memory('done'+i,`In /work/atlas-memory-engine, historical operation ${i} completed.`));
 records.push(memory('wanted','atlas-memory-engine recall quality is not yet accepted; original query fails.'));
 const result=nominateProgress(records,{scope:'/work',query:'commit push',resources:operationResources('bash','cd /work/atlas-memory-engine && git push','/work')});
 assert.equal(result.targets.length,8);assert.equal(result.targets[0],'wanted');
});

test('nomination does not treat capture origin, same basename in another absolute path, or suppressed states as authority',()=>{
 const records=[memory('wrong','Other project unrelated state.'),memory('other-path','/other/atlas-memory-engine validation pending.'),
  memory('forgotten','atlas-memory-engine validation pending.',{status:'forgotten'}),memory('pinned','atlas-memory-engine validation pending.',{layer:'pinned'}),
  memory('cross','atlas-memory-engine validation pending.',{scope:'/other-origin'}),memory('fact','atlas-memory-engine validation pending.',{kind:'fact'})];
 const input={scope:'/work',query:'继续',resources:operationResources('bash','cd /work/atlas-memory-engine && npm test','/work')};
 assert.deepEqual(nominateProgress(records,input).targets,[]);
 assert.deepEqual(nominateProgress([memory('other-path','/other/atlas-memory-engine commit and push pending.')],{...input,query:'commit push'}).targets,[]);
 assert.deepEqual(nominateProgress([memory('generic','Unrelated state.')],{scope:'/work',query:'继续',resources:operationResources('bash','cd /work && npm test','/')}).targets,[]);
});

test('generic work words without subject or operation resources nominate nothing',()=>{
 assert.deepEqual(nominateProgress([memory('old','Atlas validation pending.')],{scope:'/work',query:'请接着继续',resources:[]}).targets,[]);
});

test('natural requirements and priorities learn without a magic remember keyword',()=>{
 for(const text of [
  '我比较在意的三大功能，自进化（自动更新，衰退，自排序，来源区分可信度等），相关注入，自动召回。这些你觉得做得怎么样？',
  '我们的核心需求是跨会话记忆和自动更新。','我希望系统每次都能自动召回相关背景。','我喜欢简洁的解释。',
  'Our priorities are automatic evolution, relevant injection and automatic recall. What do you think?',
  'Our project must preserve provenance and update stale progress.','我喜欢茶。','我们决定采用 SQLite 数据库。','We decided to use SQLite.',
 ])assert.equal(learningIntent(text).learn,true,text);
});

test('questions, vague continuations, quoted examples and one-off commands are not durable requirements',()=>{
 for(const text of ['请接着继续','你还知道我们项目要实现的需求吧？','我需要你运行测试。','我的要求是什么？','我在意什么？',
  'What do you remember about my project requirements?','例如：我喜欢简洁的解释。','"Our priorities are automatic memory."',
  'Suppose our project must preserve provenance.','你觉得这个偏好怎么设置？','当前偏好设置在哪里？','Do I prefer tea?'])assert.equal(learningIntent(text).learn,false,text);
});
