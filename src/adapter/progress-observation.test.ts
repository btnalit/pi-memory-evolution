import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressObservation } from './progress-observation.ts';
const turn=():any[]=>[
 {role:'user',timestamp:1000,content:'Commit fixture changes and push them.'},
 {role:'assistant',timestamp:1001,stopReason:'toolUse',content:[{type:'toolCall',id:'call',name:'bash',arguments:{command:'git commit && git push'}}]},
 {role:'toolResult',timestamp:1002,toolCallId:'call',toolName:'bash',isError:true,content:[{type:'text',text:'Local commit created. Push failed: no remote.'}]},
 {role:'assistant',timestamp:1003,stopReason:'stop',content:[{type:'text',text:'Commit created; push still pending.'}]},
];
test('completed work captures linked tools and failures as data, stably across replay',()=>{
 const event=turn();const result=progressObservation(event,'session')!;
 assert.equal(result.kind,'progress');assert.equal(result.id,progressObservation(event,'session')!.id);
 assert.equal(result.createdAt,new Date(1003).toISOString());
 const payload=JSON.parse(result.content);assert.equal(payload.observations[0].isError,true);
 assert.match(payload.observations[0].arguments,/git push/);assert.match(payload.assistantReport,/pending/);
});
test('assistant-only, unmatched tool output, unfinished turns and old-turn tools cannot trigger learning',()=>{
 for(const modify of [
  (m:any[])=>m.slice(1),
  (m:any[])=>{m[0].content='Hello.';return m;},
  (m:any[])=>{m[3].stopReason='aborted';return m;},
  (m:any[])=>{m[2].toolName='unmatched';return m;},
  (m:any[])=>[m[0],m[3]],
  (m:any[])=>[...m,{role:'user',timestamp:2000,content:'Now commit another task.'},m[3]],
 ])assert.equal(progressObservation(modify(turn()),'session'),undefined);
});
test('observation payload is bounded and sanitized, with no image/code payload copied from arguments',()=>{
 const m=turn();m[1].content[0].arguments={path:'/fixture/readme.md',content:'private file contents never needed'};
 m[2].content=[{type:'image',data:'image-data'},{type:'text',text:'token=synthetic-secret\n'+'🙂 prefix '.repeat(6000)+'\nPush failed at the end.'}];
 const observation=progressObservation(m,'session')!;
 assert.ok(Buffer.byteLength(observation.content)<=28000);
 assert.ok(!observation.content.includes('synthetic-secret'));assert.ok(!observation.content.includes('private file contents'));assert.ok(!observation.content.includes('image-data'));
 assert.match(observation.content,/Push failed at the end/);assert.equal(JSON.parse(observation.content).observations[0].arguments,'/fixture/readme.md');
});
