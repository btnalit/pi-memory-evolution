import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { MemoryStore, type Source } from "./memory-store.ts";
import { Database } from "./sqlite.ts";
import { selectRelevantMemories } from "./retriever.ts";
import { archiveLegacyFiles, legacyFiles } from "./legacy-files.ts";

function temp() { return mkdtempSync(join(tmpdir(), "pme-v2-")); }
const source = (id = "s1", content = "## Critical Context\n- Database port is 5432.", scope = "/project"): Source => ({ id, scope, kind: "summary", content, createdAt: new Date().toISOString() });
function using(fn: (s: MemoryStore, dir: string) => void) {
	let dir: string | undefined, s: MemoryStore | undefined;
	try { dir = temp(); s = new MemoryStore(dir); fn(s,dir); } finally { s?.close(); if (dir) rmSync(dir,{recursive:true,force:true}); }
}

test("capture commits evidence and claims once; no raw summary in recall", () => using((s) => {
	assert.equal(s.capture(source()), true); assert.equal(s.capture(source()), false);
	assert.equal(s.readMemories().length, 1); assert.equal(s.history().length, 1);
	assert.equal(s.readMemories()[0].kind, "fact");
}));
test("same claim from multiple compactions deduplicates", () => using((s) => {
	s.capture(source()); s.capture(source("s2")); assert.equal(s.readMemories().length, 1);
}));
test("forget cannot return through parent or later extraction", () => using((s) => {
	s.capture(source()); s.act(s.readMemories()[0].id, "forget"); s.capture(source("s2"));
	assert.deepEqual(selectRelevantMemories(s.readMemories(), "Database port"), []);
}));
test("correction does not reappear from summary, even across reload", () => {
	let dir: string | undefined, s: MemoryStore | undefined;
	try {
		dir = temp(); s = new MemoryStore(dir);
		s.capture(source()); const id = s.readMemories()[0].id;
		s.act(id, "correct", "Database port is 9999."); s.close(); s = new MemoryStore(dir);
		s.capture(source("s2")); assert.deepEqual(s.readMemories().map((m) => m.content), ["Database port is 9999."]);
	} finally { s?.close(); if (dir) rmSync(dir,{recursive:true,force:true}); }
});
test("conflict suppresses both sides; pin cannot revive conflict", () => using((s) => {
	s.capture(source()); s.capture(source("s2", "## Critical Context\n- Database port is 9999."));
	const [a,b] = s.readMemories(); s.act(a.id,"conflict",b.id);
	assert.deepEqual(selectRelevantMemories(s.readMemories(),"Database port"),[]);
	assert.throws(() => s.act(a.id,"pin")); s.act(a.id,"resolve");
	assert.equal(selectRelevantMemories(s.readMemories(),"Database port").length,1);
}));
test("automatic replacement retires old claim and records reversible actual changes", () => using((s) => {
	s.capture(source()); const old = s.readMemories()[0];
	s.capture({ ...source("s2"), kind:"user", content:"Remember, database port changed to 9999." });
	const run = s.beginEvolution("s2")!;
	const event = s.finishEvolution(run,[{ kind:"fact",content:"Database port is 9999.",replaces:old.id }],"test/model");
	assert.equal(s.readMemories().find((m) => m.id===old.id)?.status,"forgotten");
	assert.ok(s.readMemories().some((m) => m.content.includes("9999") && m.status === "provisional"));
	s.undo(event);
	assert.equal(selectRelevantMemories(s.readMemories(),"Database port")[0].content,"Database port is 5432.");
	assert.throws(() => s.undo(event));
}));
test("replacement works when local extractor already captured the new claim", () => using((s) => {
	s.capture(source()); const old = s.readMemories()[0];
	s.capture(source("s2", "## Critical Context\n- Database port is 9999."));
	s.finishEvolution(s.beginEvolution("s2")!, [{kind:"fact",content:"Database port is 9999.",replaces:old.id}],"model");
	const selected=selectRelevantMemories(s.readMemories(),"Database port");
	assert.equal(selected.length,1); assert.match(selected[0].content,/9999/);
}));
test("unknown replacement rolls back entire batch, including earlier additions", () => using((s) => {
	s.capture(source()); const before=s.readMemories(); const run=s.beginEvolution("s1")!;
	assert.throws(() => s.finishEvolution(run,[{kind:"fact",content:"A valid new fact."},{kind:"fact",content:"Another fact.",replaces:"../../outside"}],"model"));
	assert.deepEqual(s.readMemories(),before);
}));
test("LLM cannot overwrite pinned memories", () => using((s) => {
	s.capture(source()); const old=s.readMemories()[0]; s.act(old.id,"pin");
	const run=s.beginEvolution("s1")!;
	assert.throws(() => s.finishEvolution(run,[{kind:"fact",content:"Database port is 1111.",replaces:old.id}],"model"));
}));
test("global recall does not grant automatic cross-origin replacement authority", () => using((s) => {
	s.capture(source('a','## Critical Context\n- Database port is 5432.','/Alpha'));
	const original=s.readMemories()[0];
	s.capture({...source('b','Remember Beta database port is 7777.','/Beta'),kind:'user'});
	const run=s.beginEvolution('b')!;
	assert.ok(!run.memories.some(m=>m.id===original.id));
	assert.throws(()=>s.finishEvolution(run,[{kind:'fact',content:'Database port is 7777.',replaces:original.id}],'model'));
	// Even a future caller accidentally widening candidates cannot bypass the write guard.
	run.candidates.push(original);
	assert.throws(()=>s.finishEvolution(run,[{kind:'fact',content:'Database port is 7777.',replaces:original.id}],'model'));
	assert.equal(s.readMemories()[0].status,'provisional');
}));
test("identical cross-origin facts are not merged or silently deleted by an exact-ID action", () => using((s) => {
	s.capture(source('a',undefined,'/Alpha'));s.capture(source('b',undefined,'/Beta'));
	const [a,b]=s.readMemories();assert.equal(selectRelevantMemories(s.readMemories(),'Database port').length,2);
	s.act(a.id,'correct','Database port is 9999.');
	assert.equal(s.readMemories().find(m=>m.id===b.id)!.content,'Database port is 5432.');
	s.act(a.id,'forget');assert.deepEqual(selectRelevantMemories(s.readMemories(),'Database port').map(m=>m.id),[b.id]);
	s.capture(source('again',undefined,'/Alpha'));assert.equal(s.readMemories().length,2);
}));
test("pending selection and explicit retry work across capture origins", () => using((s) => {
	s.capture(source('a',undefined,'/Alpha'));s.capture(source('b',undefined,'/Beta'));
	assert.equal(s.pending(),'b');assert.equal(s.pending('/Alpha'),'a');
	s.failEvolution(s.beginEvolution('b')!);
	assert.equal(s.pending(),'a');assert.equal(s.pending(undefined,true),'b');
}));
test("in-flight model output loses authority after manual edit", () => using((s) => {
	s.capture(source()); const run=s.beginEvolution("s1")!;
	s.act(s.readMemories()[0].id,"forget");
	assert.throws(() => s.finishEvolution(run,[{kind:"fact",content:"Database is on port 5432."}],"model"),/stale/);
	assert.deepEqual(selectRelevantMemories(s.readMemories(),"Database port"),[]);
}));
test("stale model result from an older source cannot replace newer facts", () => using((s) => {
	s.capture(source()); s.capture({...source("old"),createdAt:"2000-01-01T00:00:00.000Z"});
	const run=s.beginEvolution("old")!;
	assert.throws(() => s.finishEvolution(run,[{kind:"fact",content:"Database port is 1111.",replaces:s.readMemories()[0].id}],"model"));
}));
test("manual suppression retires pending raw source, so reload cannot relearn it", () => using((s) => {
	s.capture(source()); s.act(s.readMemories()[0].id, "forget");
	assert.equal(s.pending("/project", true), undefined);
	assert.equal(s.beginEvolution("s1", true), undefined);
}));
test("cyclic model replacements cannot retire both facts", () => using((s) => {
	s.capture(source()); s.capture(source("s2", "## Critical Context\n- Database port is 9999."));
	const [a,b] = s.readMemories(); const before = s.readMemories();
	assert.throws(() => s.finishEvolution(s.beginEvolution("s2")!, [
		{kind: "fact", content: b.content, replaces: a.id},
		{kind: "fact", content: a.content, replaces: b.id},
	], "model"), /Cyclic/);
	assert.deepEqual(s.readMemories(), before);
}));
test("job lease prevents duplicate model execution; failed job can retry explicitly", () => using((s) => {
	s.capture(source()); const run=s.beginEvolution("s1")!; assert.equal(s.beginEvolution("s1"),undefined);
	s.failEvolution(run); assert.equal(s.pending("/project"),undefined);
	assert.equal(s.pending("/project",true),"s1"); assert.ok(s.beginEvolution("s1",true));
}));
test("resume finds persisted pending jobs without another compaction", () => {
	let dir: string | undefined, s: MemoryStore | undefined;
	try { dir=temp(); s=new MemoryStore(dir); s.capture(source());s.close();s=new MemoryStore(dir);assert.equal(s.pending("/project"),"s1"); }
	finally {s?.close();if(dir)rmSync(dir,{recursive:true,force:true});}
});
test("cross-process cache invalidation and independent scopes", () => using((s,dir) => {
	s.capture(source());assert.equal(s.readMemories().length,1);
	const second=new MemoryStore(dir);
	try {second.capture(source("s2","## Critical Context\n- Other project uses SQLite.","/other"));assert.equal(s.readMemories().length,2);assert.equal(s.readMemories("/project").length,1);}
	finally {second.close();}
}));
test("sensitive captures and edits never leak synthetic credentials", () => using((s,dir) => {
	const examples=['token=demo_plain','密码：demo_chinese','{"password":"demo_json"}','Authorization: Bearer demo_bearer','github_pat_demo123','password="hello demo_tail"'];
	for(let i=0;i<examples.length;i++)s.capture(source(`secret${i}`,examples[i]));
	s.capture(source()); assert.throws(()=>s.act(s.readMemories()[0].id,"correct","password=demo_edit"));
	for(const file of ["memory.sqlite","memory.sqlite-wal"]) {
		const data=readFileSync(join(dir,file)); for(const secret of ["demo_plain","demo_chinese","demo_json","demo_bearer","demo123","demo_tail","demo_edit"])assert.equal(data.includes(Buffer.from(secret)),false);
	}
	assert.equal(statSync(join(dir,"memory.sqlite")).mode & 0o777,0o600);
}));

const legacy = (id:string,content:string,kind="compaction_summary") => ({version:1,id,kind,sourceEntryId:"entry1",createdAt:"2026-09-01T00:00:00.000Z",content});
test("legacy import is once-only, preserves files and recalls unknown-origin claims without adoption", () => {
	const dir=temp();const data=JSON.stringify(legacy("parent","## Critical Context\n- Database port is 5432."))+"\n";
	writeFileSync(join(dir,"memories.jsonl"),data);
	let s=new MemoryStore(dir);
	try {
		assert.equal(s.readMemories().length,1);assert.equal(s.readMemories("/project").length,0);
		assert.equal(selectRelevantMemories(s.readMemories(),'Database port')[0].scope,'legacy');
		const id=s.readMemories()[0].id;s.act(id,"adopt","/project");assert.equal(s.readMemories("/project").length,1);
		s.close();s=new MemoryStore(dir);assert.equal(s.readMemories().length,1);assert.equal(readFileSync(join(dir,"memories.jsonl"),"utf8"),data);
	}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test("damaged or unreadable legacy action ledger stops import, never fails open", () => {
	// The store still opens so status/repair stay reachable, but nothing imports and learning stays closed.
	for(const broken of ["{broken",JSON.stringify({version:1,type:"correct",memoryId:"parent",createdAt:"2026-09-01",content:123}),undefined]) {
		const dir=temp();
		try{
			writeFileSync(join(dir,"memories.jsonl"),JSON.stringify(legacy("parent","old content"))+"\n");
			if(broken===undefined) mkdirSync(join(dir,"memory-actions.jsonl")); else writeFileSync(join(dir,"memory-actions.jsonl"),broken);
			const s=new MemoryStore(dir);
			try{
				assert.equal(s.readMemories().length,0,"no partial import");
				assert.equal(s.history().length,0);
				assert.match(s.status(),/Legacy import: failed/);
				assert.throws(()=>s.capture(source()),(e:any)=>e.code==="unavailable");
				assert.throws(()=>s.beginEvolution("s1"),(e:any)=>e.code==="unavailable");
				// An explicit retry re-reads the damaged ledger and stays failed rather than importing partially.
				assert.throws(()=>s.importLegacy(),/Legacy import failed/);
				assert.equal(s.readMemories().length,0);
			}finally{s.close();}
			// The failure is persisted, not a transient in-memory flag.
			const reopened=new MemoryStore(dir);
			try{assert.match(reopened.status(),/Legacy import: failed/);assert.equal(reopened.readMemories().length,0);}finally{reopened.close();}
		}finally{rmSync(dir,{recursive:true,force:true});}
	}
});
test("a failed legacy import cannot be bypassed by pointing at an empty directory", () => {
	// Both directories are created inside the try, so a failure creating the second still cleans the first.
	let dir: string | undefined, empty: string | undefined;
	try{
		dir=temp(); empty=temp();
		writeFileSync(join(dir,"memories.jsonl"),"{broken");
		const s=new MemoryStore(dir);
		try{
			assert.match(s.status(),/Legacy import: failed/);
			assert.equal(s.importLegacy(empty!).state,"failed");
			assert.throws(()=>s.capture(source()),(e:any)=>e.code==="unavailable");
		}finally{s.close();}
	}finally{for(const d of [dir,empty]) if(d) rmSync(d,{recursive:true,force:true});}
});
test("legacy import state is tracked separately from schema creation, so a later ledger still imports", () => {
	const dir=temp();
	try{
		// R3: a first run with no ledger must not permanently disable import.
		let s=new MemoryStore(dir);
		try{assert.match(s.status(),/Legacy import: not_found/);assert.equal(s.readMemories().length,0);}finally{s.close();}
		writeFileSync(join(dir,"memories.jsonl"),[legacy("parent","Database port is 5432.","fact"),legacy("gone","Obsolete note.","fact")].map(m=>JSON.stringify(m)).join("\n")+"\n");
		writeFileSync(join(dir,"memory-actions.jsonl"),JSON.stringify({version:1,memoryId:"gone",type:"forget",createdAt:"2026-09-02T00:00:00.000Z"})+"\n");
		s=new MemoryStore(dir);
		try{
			// Opening after the ledger appeared must not silently skip it, and the import is explicit and repeatable.
			const first=s.importLegacy();
			assert.equal(first.state,"completed");assert.ok(first.imported>=1);
			const imported=s.readMemories();
			assert.ok(imported.some(m=>m.content.includes("5432")));
			assert.ok(!imported.some(m=>m.content.includes("Obsolete note.")&&m.status!=="forgotten"),"a forgotten record must not be revived");
			// Repeat-safe: a completed import is never replayed over newer edits.
			assert.deepEqual(s.importLegacy(),{state:"completed",imported:0});
			assert.deepEqual(s.readMemories(),imported);
			assert.match(s.status(),/Legacy import: completed/);
		}finally{s.close();}
	}finally{rmSync(dir,{recursive:true,force:true});}
});
test("legacy summary correction extracts correct revision, not forgotten new children",()=>{
	const dir=temp();
	try{
		writeFileSync(join(dir,"memories.jsonl"),[legacy("parent","## Critical Context\n- Database port is 5432."),legacy("child","Database port is 5432.","fact")].map((m)=>JSON.stringify(m)).join("\n")+"\n");
		writeFileSync(join(dir,"memory-actions.jsonl"),JSON.stringify({version:1,memoryId:"parent",type:"correct",createdAt:"2026-09-02T00:00:00.000Z",content:"## Critical Context\n- Database port is 9999."})+"\n");
		const s=new MemoryStore(dir);try{assert.equal(s.readMemories().find((m)=>m.content.includes("9999"))?.status,"confirmed");assert.equal(s.readMemories().find((m)=>m.content.includes("5432"))?.status,"forgotten");}finally{s.close();}
	}finally{rmSync(dir,{recursive:true,force:true});}
});
test("incompatible schema and corrupted records fail closed", () => {
	let dir: string | undefined, s: MemoryStore | undefined;
	try {
		dir=temp(); s=new MemoryStore(dir);
		s.capture(source()); s.close();
		const db=new Database(join(dir,"memory.sqlite"));
		db.exec("UPDATE metadata SET value='999' WHERE key='schema'");
		assert.throws(()=>new MemoryStore(dir!), /version/);
		db.exec("UPDATE metadata SET value='2' WHERE key='schema'; UPDATE memories SET data='null'"); db.close();
		s=new MemoryStore(dir); assert.throws(()=>s!.readMemories(), /Invalid memory/);
	} finally { s?.close(); if (dir) rmSync(dir,{recursive:true,force:true}); }
});
test("process exit during an uncommitted transaction preserves the last committed state", async () => {
	let dir: string | undefined;
	try {
		dir=temp(); const s=new MemoryStore(dir);s.capture(source());s.close();
		const code=`import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(${JSON.stringify(join(dir,'memory.sqlite'))});d.exec(\"BEGIN IMMEDIATE; DELETE FROM memories;\");process.exit(0);`;
		await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});child.on('error',reject);child.on('exit',(c)=>c===0?resolve():reject(new Error('child failed')));});
		const reopened=new MemoryStore(dir);try{assert.equal(reopened.readMemories().length,1);assert.match(reopened.status(),/SQLite ok/);}finally{reopened.close();}
	} finally { if (dir) rmSync(dir,{recursive:true,force:true}); }
});
test("multiple processes capture concurrently without lost records",async()=>{
	let dir: string | undefined;
	try {
		dir=temp();const s=new MemoryStore(dir);s.close();
		const url=new URL("./memory-store.ts",import.meta.url).href;
		await Promise.all(Array.from({length:4},(_,i)=>new Promise<void>((resolve,reject)=>{
			const code=`import {MemoryStore} from ${JSON.stringify(url)};const s=new MemoryStore(${JSON.stringify(dir)});for(let j=0;j<15;j++)s.capture({id:'${i}-'+j,scope:'/project',kind:'summary',createdAt:new Date().toISOString(),content:'## Critical Context\\n- Worker ${i} observation number '+j+'.'});s.close();`;
			const child=spawn(process.execPath,["--input-type=module","-e",code],{stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",(d)=>error+=d);child.on("error",reject);child.on("exit",(code)=>code===0?resolve():reject(new Error(error)));
		})));
		const final=new MemoryStore(dir);try{assert.equal(final.readMemories().length,60);}finally{final.close();}
	}finally{if(dir)rmSync(dir,{recursive:true,force:true});}
});

test("inactive legacy files are reported and archived by copy, never executed or deleted", () => {
	const dir=temp();
	try{
		// R2: an old planning file is inert data. It must not block learning or become an instruction.
		writeFileSync(join(dir,"self_agenda.yaml"),"- run: rm -rf /\n");
		writeFileSync(join(dir,"signals.jsonl"),"{}\n");
		assert.deepEqual(legacyFiles(dir),["self_agenda.yaml","signals.jsonl"]);
		const s=new MemoryStore(dir);
		try{
			assert.match(s.status(),/Legacy inactive files: .*self_agenda\.yaml/);
			assert.equal(s.capture(source()),true,"inactive files are not a runtime fault");
			const archive=archiveLegacyFiles(dir);
			assert.equal(archive.count,2);
			assert.equal(readFileSync(join(dir,"self_agenda.yaml"),"utf8"),"- run: rm -rf /\n","originals are retained");
			assert.equal(readFileSync(join(archive.directory!,"self_agenda.yaml"),"utf8"),"- run: rm -rf /\n");
			const manifest=JSON.parse(readFileSync(join(archive.directory!,"manifest.json"),"utf8"));
			assert.equal(manifest.originalsRetained,true); assert.equal(manifest.files.length,2);
			assert.deepEqual(legacyFiles(dir),["self_agenda.yaml","signals.jsonl"],"archiving never deletes originals");
			// The archived plan is never imported as memory.
			assert.ok(!s.readMemories().some(m=>m.content.includes("rm -rf")));
		}finally{s.close();}
	}finally{rmSync(dir,{recursive:true,force:true});}
});
