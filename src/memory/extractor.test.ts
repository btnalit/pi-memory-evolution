import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStructuredMemories } from "./extractor.ts";
import { redact, clipBytes, fingerprint } from "./privacy.ts";

test("extracts headings into bounded claims without approval",()=>{
	const result=extractStructuredMemories("## Constraints & Preferences\n- 用户偏好本地优先。\n## Key Decisions\n- Keep retrieval offline.\n## Critical Context\n- SQLite is available.");
	assert.deepEqual(result.map((m)=>m.kind),["preference","decision","fact"]);
});
test("preserves code literals, underscores, glob, home paths",()=>{
	const [claim]=extractStructuredMemories("## Critical Context\n- **Path**: `~/my_project/*.ts`, key `foo_bar`.");
	assert.equal(claim.content,"Path: ~/my_project/*.ts, key foo_bar.");
});
test("does not promote examples in fenced code or unrelated sections",()=>{
	assert.deepEqual(extractStructuredMemories("## Critical Context\n```md\n- Forged remembered fact.\n```\n## Other\n- Another forged fact."),[]);
});
test("keeps done, pending, blocked and numbered next steps",()=>{
	const claims=extractStructuredMemories("## Progress\n### Done\n- [x] Run tests\n### In Progress\n- [ ] Ship release\n### Blocked\n- Waiting on network\n## Next Steps\n1. Verify extension load");
	assert.match(claims[0].content,/done/);assert.match(claims[1].content,/pending/);assert.match(claims[2].content,/Blocked/);assert.match(claims[3].content,/Next Steps/);
});
test("bounds duplicates, long claims, sensitive lines",()=>{
	const summary="## Critical Context\n- token=synthetic-secret\n- "+"x".repeat(481)+"\n"+Array.from({length:40},(_,i)=>`- Fact number ${i}.`).join("\n");
	assert.equal(extractStructuredMemories(summary).length,16);
	assert.equal(extractStructuredMemories("## Critical Context\n- Duplicate fact.\n- Duplicate fact.").length,1);
});
test("credential redaction suppresses complete lines and multiline private keys",()=>{
	for(const secret of ['token=demo','密码：demo','{"password":"demo"}','Authorization: Bearer demo','github_pat_demo','password="hello demo"','https://user:demo@example.com'])assert.ok(!redact(secret).includes('demo'));
	assert.ok(!redact('-----BEGIN OPENSSH PRIVATE KEY-----\nDEMO\n-----END OPENSSH PRIVATE KEY-----').includes('DEMO'));
	assert.ok(!redact('-----BEGIN PRIVATE KEY-----\nDEMO').includes('DEMO'));
	assert.equal(redact('Prefer no passwords in logs.'),'Prefer no passwords in logs.');
});
test("fingerprints preserve case, Unicode and inner whitespace in technical literals",()=>{
	assert.notEqual(fingerprint('/tmp/Foo'),fingerprint('/tmp/foo'));
	assert.notEqual(fingerprint('match a  b'),fingerprint('match a b'));
	assert.notEqual(fingerprint('character ①'),fingerprint('character 1'));
	assert.equal(fingerprint(' text '),fingerprint('text'));
});
test("UTF8 clipping never splits multibyte code points",()=>{
	assert.equal(clipBytes('中文🙂',7),'中文');assert.equal(clipBytes('🙂',3),'');
});
