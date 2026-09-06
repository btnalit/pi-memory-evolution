import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, type Source } from './memory-store.ts';
import { Database } from './sqlite.ts';
import { redact } from './privacy.ts';
import { extractStructuredMemories } from './extractor.ts';
import { selectRelevantMemories } from './retriever.ts';

const source = (id: string, content = '## Critical Context\n- Database port is 5432.', scope = '/project'): Source => ({ id, content, scope, kind: 'summary', createdAt: new Date().toISOString() });
function using(fn: (store: MemoryStore, dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'pme-review-')); const store = new MemoryStore(dir);
	try { fn(store, dir); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('mixed lifecycle sequences preserve transaction, history and scope invariants', () => using((store) => {
	let seed=17; const random=(n:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
	let applied=0;
	for(let i=0;i<150;i++) {
		const scope=['/project','/other','legacy'][random(3)];
		const before=store.readMemories(); const target=before.length?before[random(before.length)]:undefined;
		let run:ReturnType<MemoryStore['beginEvolution']>=undefined;
		try {
			const op=random(10);
			if(op<3 || !target) store.capture(source(`sequence-${i}`,`## Critical Context\n- Database configuration number ${random(17)}.`,scope));
			else if(op===3) store.act(target.id,'correct',`Database correction number ${random(7)}.`);
			else if(op===4) store.act(target.id,'forget');
			else if(op===5) store.act(target.id,random(2)?'pin':'unpin');
			else if(op===6) store.act(target.id,'conflict',before[random(before.length)].id);
			else if(op===7) store.act(target.id,target.scope==='legacy'?'adopt':'resolve','/project');
			else if(op===8) store.undo(store.history()[random(store.history().length)].id);
			else {
				const pending=store.pending(scope,true);run=pending?store.beginEvolution(pending,true):undefined;
				if(run) store.finishEvolution(run,[{kind:'fact',content:`Database model value ${random(5)}.`,...(run.memories[0]?{replaces:run.memories[0].id}:{})}],'test');
			}
			applied++;
		} catch {
			assert.deepEqual(store.readMemories(),before);
			if(run) store.failEvolution(run);
		}
		assert.match(store.status(),/SQLite ok/);
		assert.ok(store.readMemories('/project').every((m)=>m.scope==='/project'));
	}
	assert.ok(applied>40);
}));
test('redaction normalizes controls before checking credential labels', () => {
	assert.ok(!redact('pass\u0000word=synthetic-value').includes('synthetic-value'));
});
test('redaction suppresses YAML blocks and multiline quoted/JSON values', () => {
	for (const input of ['password: |\n  synthetic-value\n  synthetic-tail\nsafe: yes', '"password":\n"synthetic-value"', 'password="first\nsynthetic-value"', 'password:\n  synthetic-value']) {
		assert.ok(!redact(input).includes('synthetic-'), input);
	}
});
test('nested code fences cannot escape into local extraction', () => {
	assert.deepEqual(extractStructuredMemories('## Critical Context\n````md\n```sh\n- This is an example, not a fact.\n```\n````'), []);
});
test('recursive globs and nested inline backticks retain their literal meaning', () => {
	const [claim] = extractStructuredMemories('## Critical Context\n- **Path**: `**/vendor/**`, `` `literal` ``.');
	assert.equal(claim.content, 'Path: **/vendor/**, `literal`.');
});
test('progress siblings inherit the original section after a recognized subheading', () => {
	const claims = extractStructuredMemories('## Progress\n### Blocked\n- Waiting on database.\n### Done\n- Installed SQLite.');
	assert.equal(claims.length, 2); assert.match(claims[1].content, /Done/);
});
test('pin/unpin, adoption and undo do not refresh stale project evidence', () => using((store) => {
	const at='2020-01-01T00:00:00Z';
	store.capture({...source('s1','## Progress\n- Old database task.','legacy'),createdAt:at});
	const id=store.readMemories()[0].id;
	store.act(id,'adopt','/project');
	const pin=store.act(id,'pin');store.undo(pin);
	store.act(id,'pin');store.act(id,'unpin');
	assert.equal(Date.parse(store.readMemories()[0].updatedAt),Date.parse(at));
	assert.deepEqual(selectRelevantMemories(store.readMemories('/project'),'database'),[]);
}));
test('explicit origin filters treat wildcard-like scope names literally', () => using((store) => {
	store.capture(source('s1', '## Critical Context\n- Private project preference.', '*'));
	assert.equal(store.readMemories('/project').length,0);
}));
test('content-addressed IDs cannot collide through colon-separated scope components', () => using((store) => {
	store.capture(source('s1', '## Critical Context\n- A valid fact.', '/project:fact:prefix'));
	store.capture(source('s2', '## Critical Context\n- prefix:fact:A valid fact.', '/project'));
	assert.equal(store.readMemories().length, 2);
}));
test('forget retires other pending sources that repeat the same fact', () => using((store) => {
	store.capture(source('s1')); store.capture(source('s2'));
	store.act(store.readMemories()[0].id, 'forget');
	assert.equal(store.beginEvolution('s2'), undefined);
}));
test('undo rejects a corrupted before/after pairing instead of overwriting another record', () => using((store, dir) => {
	store.capture(source('s1')); store.capture(source('s2', '## Critical Context\n- The network uses WiFi.'));
	const [a, b] = store.readMemories(); const id = store.act(a.id, 'pin');
	const event = store.history().find((e) => e.id === id)!; event.before[0] = b;
	const db = new Database(join(dir, 'memory.sqlite')); db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(event), id); db.close();
	const before = store.readMemories(); assert.throws(() => store.undo(id)); assert.deepEqual(store.readMemories(), before);
	assert.throws(() => store.status(), /history/);
}));
test('suppression recognizes formatted repeats beyond the extraction quota', () => using((store) => {
	store.capture(source('s1','## Critical Context\n- Database uses `SQLite`.'));
	const target=store.readMemories()[0];
	store.capture(source('s2','## Critical Context\n'+Array.from({length:20},(_,i)=>`- New fact number ${i}.`).join('\n')+'\n- Database uses `SQLite`.'));
	store.act(target.id,'forget');assert.equal(store.beginEvolution('s2'),undefined);
}));
test('unsupported schemas are rejected before any DDL is applied', () => using((_store, dir) => {
	const db=new Database(join(dir,'memory.sqlite'));
	try {
		db.exec("DROP INDEX memories_scope_hash; UPDATE metadata SET value='999' WHERE key='schema'");
		assert.throws(()=>new MemoryStore(dir),/version/);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='memories_scope_hash'").get()!.n,0);
	} finally {db.close();}
}));
test('same-batch duplicate content is stored once even with different kinds', () => using((store) => {
	store.capture(source('s1', '## Critical Context\n- Prefer local storage.\n## Constraints & Preferences\n- Prefer local storage.'));
	assert.equal(store.readMemories().length, 1);
	store.finishEvolution(store.beginEvolution('s1')!, [
		{kind:'fact',content:'Use a local database.'},{kind:'preference',content:'Use a local database.'},
	], 'test');
	assert.equal(store.readMemories().length, 2);
}));
test('status detects corrupted source jobs even when SQLite itself is intact', () => using((store, dir) => {
	store.capture(source('s1')); const db=new Database(join(dir,'memory.sqlite'));
	try { db.exec("UPDATE sources SET data='null'"); assert.throws(()=>store.status(),/source/); }
	finally {db.close();}
}));
test('content/hash inconsistency and malformed source identity fail closed', () => using((store, dir) => {
	store.capture(source('s1')); const db=new Database(join(dir,'memory.sqlite'));
	try {
		db.exec("UPDATE memories SET hash='wrong'"); assert.throws(()=>store.readMemories());
		db.exec("UPDATE sources SET data=json_set(data,'$.id','other')"); assert.throws(()=>store.beginEvolution('s1'));
	} finally {db.close();}
}));
test('legacy correction suppression follows adoption into a project', () => {
	const dir=mkdtempSync(join(tmpdir(),'pme-review-adopt-'));
	try {
		writeFileSync(join(dir,'memories.jsonl'),JSON.stringify({version:1,id:'child',kind:'fact',sourceEntryId:'entry',createdAt:'2026-09-01T00:00:00Z',content:'Database port is 5432.'}));
		writeFileSync(join(dir,'memory-actions.jsonl'),JSON.stringify({version:1,memoryId:'child',type:'correct',createdAt:'2026-09-02T00:00:00Z',content:'Database port is 9999.'}));
		const store=new MemoryStore(dir);
		try {
			store.act('child','adopt','/project'); store.capture(source('again'));
			assert.deepEqual(store.readMemories('/project').map((m)=>m.content),['Database port is 9999.']);
			const copy=store.readMemories('/project')[0];copy.suppressedHashes!.push('0'.repeat(24));
			assert.equal(store.readMemories('/project')[0].suppressedHashes!.length,1);
		} finally {store.close();}
	} finally {rmSync(dir,{recursive:true,force:true});}
});
test('a later parent correction can still derive new facts after a child was corrected', () => {
	const dir=mkdtempSync(join(tmpdir(),'pme-review-revision-'));
	const base={version:1,sourceEntryId:'entry',createdAt:'2026-09-01T00:00:00Z'};
	try {
		writeFileSync(join(dir,'memories.jsonl'),[
			{...base,id:'parent',kind:'compaction_summary',content:'## Critical Context\n- Database port is 5432.'},
			{...base,id:'child',kind:'fact',content:'Database port is 5432.'},
		].map((r)=>JSON.stringify(r)).join('\n'));
		writeFileSync(join(dir,'memory-actions.jsonl'),[
			{...base,memoryId:'child',type:'correct',content:'Database port is 9999.'},
			{...base,memoryId:'parent',type:'correct',content:'## Critical Context\n- Database port is 9999.\n- Network uses WiFi.'},
		].map((r)=>JSON.stringify(r)).join('\n'));
		const store=new MemoryStore(dir);
		try {assert.ok(store.readMemories().some((m)=>m.content==='Network uses WiFi.'));}
		finally {store.close();}
	} finally {rmSync(dir,{recursive:true,force:true});}
});
test('legacy parent correction preserves unchanged children in the new revision', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pme-review-legacy-'));
	const base = { version: 1, sourceEntryId: 'entry1', createdAt: '2026-09-01T00:00:00Z' };
	try {
		writeFileSync(join(dir, 'memories.jsonl'), [
			{ ...base, id: 'parent', kind: 'compaction_summary', content: '## Critical Context\n- Database port is 5432.\n- Database uses SQLite.' },
			{ ...base, id: 'child', kind: 'fact', content: 'Database uses SQLite.' },
		].map((r) => JSON.stringify(r)).join('\n'));
		writeFileSync(join(dir, 'memory-actions.jsonl'), JSON.stringify({ ...base, memoryId: 'parent', type: 'correct', content: '## Critical Context\n- Database port is 9999.\n- Database uses SQLite.' }));
		const store = new MemoryStore(dir);
		try { assert.ok(store.readMemories().some((m) => m.content === 'Database uses SQLite.' && m.status !== 'forgotten')); }
		finally { store.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
