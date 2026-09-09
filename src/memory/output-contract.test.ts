import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeMemory } from '../adapter/pi-api.ts';
import { parseClaims } from './evolution.ts';
import { parseMemoryOutput } from './output.ts';

const fact = { kind: 'fact', content: 'Atlas uses SQLite.' };
const json = JSON.stringify({ memories: [fact] });
const text = (value: string, phase?: string, id = 'message') => ({ type: 'text', text: value,
 ...(phase ? { textSignature: JSON.stringify({ v: 1, id, phase }) } : {}) });
const completion = (content: unknown[], stopReason = 'stop') => completeMemory({
 model: { provider: 'fixture', id: 'model' }, modelRegistry: { complete: async () => ({ content, stopReason }) },
} as unknown as ExtensionContext, 'system', 'synthetic', AbortSignal.timeout(1000));

test('Responses commentary cannot poison or substitute for a final answer', async () => {
 const response = await completion([text('I will compare the evidence.', 'commentary', 'c'), text(json, 'final_answer', 'f')]);
 assert.deepEqual(parseClaims(response.text), [fact]);
 assert.equal(response.diagnostic?.commentaryBlocks, 1);
 await assert.rejects(completion([text(json, 'commentary')]), (e: any) => e.diagnostic.reason === 'missing_final');
 await assert.rejects(completion([text(json, 'commentary'), text('', 'final_answer')]), (e: any) => e.diagnostic.reason === 'empty_text');
 await assert.rejects(completion([text(json, 'final_answer', 'a'), text(json, 'final_answer', 'b')]), (e: any) => e.diagnostic.reason === 'ambiguous_final');
});

test('unphased providers, split text and opaque signatures remain compatible; thinking is not output', async () => {
 const result = await completion([{ type: 'thinking', thinking: 'not an answer' },
  { ...text(json.slice(0, 30)), textSignature: 'opaque-provider-signature' }, text(json.slice(30))]);
 assert.deepEqual(parseClaims(result.text), [fact]);
 await assert.rejects(completion([{ type: 'thinking', thinking: json }]), (e: any) => e.diagnostic.reason === 'empty_text');
 await assert.rejects(completion([text(json), { type: 'toolCall', name: 'bash', arguments: {} }]), (e: any) => e.diagnostic.reason === 'unexpected_tool');
});

test('bounded single JSON envelopes tolerate fences and prose without guessing among candidates', () => {
 for (const value of [json, `\uFEFF${json}`, `\`\`\`JSON\n${json}\n\`\`\``, `Here is the result:\n${json}\nEnd.`, `结果：\n\`\`\`json\n${json}\n\`\`\`\n完毕。`])
  assert.deepEqual(parseClaims(value), [fact]);
 for (const value of [`${json}\n${json}`, `first {} then ${json}`, `Result: ${json.slice(0, -1)}`, `{"broken":${json}`, '[]', '{"claims":[]}', '{"memories":[],"command":"bash"}'])
  assert.throws(() => parseClaims(value));
 assert.deepEqual(parseClaims('{"memories":[]}'), []);
 assert.deepEqual(parseClaims(JSON.stringify({ memories: [{ ...fact, content: 'Literal braces {x} and a quoted "value" stay unchanged.' }] }))[0].content,
  'Literal braces {x} and a quoted "value" stay unchanged.');
});

test('optional aliases degrade independently without accepting invalid factual fields', () => {
 const result = parseMemoryOutput(JSON.stringify({ memories: [{ ...fact, searchTerms: ['SQLite', '库', 'token=secret', null, ' database ', '数据库'] }] }));
 assert.deepEqual(result.claims, [{ ...fact, searchTerms: ['SQLite', '数据库'] }]);
 assert.equal(result.diagnostic.ignoredAliases, 4);
 for (const patch of [{ kind: 'fact|preference|decision|project_state' }, { content: 'abc' }, { replaces: null }, { verified: true }, { command: 'bash' }])
  assert.throws(() => parseClaims(JSON.stringify({ memories: [{ ...fact, ...patch }] })));
 const clean = parseMemoryOutput(JSON.stringify({ memories: [{ ...fact, searchTerms: null }] }));
 assert.deepEqual(clean.claims, [fact]);
 assert.equal(clean.diagnostic.ignoredAliases, 1);
});

test('parse diagnostics expose fixed rule/path and numeric bounds, never raw JSON or field names', () => {
 try { parseClaims(JSON.stringify({ memories: [{ ...fact, content: 'abc' }] })); assert.fail('must reject'); }
 catch (e: any) { assert.equal(e.code, 'invalid_output'); assert.equal(e.diagnostic.reason, 'content_length'); assert.equal(e.diagnostic.field, 'memories[0].content'); assert.equal(e.diagnostic.actual, 3); }
 for (const value of ['private-secret is not JSON', JSON.stringify({ memories: [{ ...fact, 'private-secret': 1 }] })]) {
  try { parseClaims(value); assert.fail('must reject'); }
  catch (e: any) { assert.ok(!JSON.stringify(e).includes('private-secret')); assert.ok(!e.message.includes('private-secret')); }
 }
});
