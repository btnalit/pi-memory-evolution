import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMemories, recallQuery, resolveRecallQuery, retrieveMemories, selectRelevantMemories } from './retriever.ts';
import { queryFeatures, queryText } from './query.ts';
import { buildRuntimeDigest } from '../injector/digest.ts';
import type { DurableMemory } from './memory-store.ts';

const now = Date.parse('2026-09-07T08:00:00Z');
const memory = (id: string, content: string, extra: Partial<DurableMemory> = {}): DurableMemory => ({
 id, content, scope: '/origin', sourceEntryId: 'synthetic', kind: 'fact', layer: 'durable', status: 'provisional',
 revision: 1, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', ...extra,
});
const subjects = [
 ['蓝牙', 'Bluetooth', '蓝牙优先使用 USB 适配器。'],
 ['数据库', 'database', '数据库使用 SQLite。'],
 ['备份', 'backup', '备份每天执行，保留三十天。'],
 ['字体', 'font', '字体使用等宽字形。'],
 ['咖啡', 'coffee', '咖啡只喝无糖的。'],
 ['旅行', 'travel', '旅行优先选择火车。'],
] as const;
const records = [
 ...subjects.map(([zh, en, content]) => memory(en, content, { searchTerms: [zh, en] })),
 memory('memory-engine', '记忆系统自动召回相关记忆，记得使用会话上下文。'),
 memory('filler', '相关记录和历史信息已经整理。'),
];
const ids = (query: string, data = records) => selectRelevantMemories(data, query, 3, now).map(m => m.id);

for (const [zh, en] of subjects) test(`conversational wrappers preserve the subject: ${en}`, () => {
 for (const query of [`${zh}相关记忆你还能记得吗？`, `你还记得之前关于${zh}的事情吗？`, `帮我回忆一下${zh}，之前是怎么说的？`,
  `What do you remember about ${en}?`, `Do you still recall our previous discussion about ${en}?`, `Any memories related to ${en}?`])
  assert.deepEqual(ids(query), [en], query);
});

test('memory implementation remains a real topic, not a recall-request wrapper', () => {
 assert.deepEqual(ids('记忆系统为什么没有自动匹配召回？'), ['memory-engine']);
 assert.deepEqual(ids('How does the memory recall system work?'), ['memory-engine']);
});

test('unknown subjects cannot fall back to memories about remembering', () => {
 for (const query of ['量子纠错相关记忆你还记得吗？', 'What do you remember about ornithology?', 'Any memories related to narwhals?', '还记得吗？'])
  assert.deepEqual(ids(query), [], query);
});

test('an incident quoting a question cannot crowd out evidence that answers it', () => {
 const data = [memory('preference', '用户要求会话也能自动注入相关记忆，不应限定于项目。', { kind: 'preference' }),
  memory('incident', 'Latest read-only replay ranks the correct Chinese preference first for the English cross-session query, but includes a weak directory result. “Pi 的记忆应该限定项目吗？” returns no results.', { kind: 'project_state' }),
  ...records];
 for (const question of ['Pi 的记忆应该限定项目吗？', 'Should memory work across sessions regardless of the project directory?'])
  assert.equal(ids(question, data)[0], 'preference', question);
 assert.deepEqual(ids('coffee', [memory('echo', '“What about coffee?” returned no results.')]), []);
 assert.equal(ids('read-only replay', data)[0], 'incident', 'the incident remains recallable for its actual topic');
});

test('unknown single-character subjects form topic barriers instead of inheriting an old match', () => {
 for (const topic of ['猫呢？', 'X', '牙音'])
  assert.deepEqual(selectRelevantMemories(records, resolveRecallQuery('继续', ['咖啡', topic]), 3, now), []);
 assert.deepEqual([...queryFeatures('那你要检查记忆系统的问题了，为什么没有自动匹配召回')], ['concept:memory', 'concept:recall', '匹配']);
});

test('exact resource qualifiers cannot be rescued by otherwise strong generic overlap', () => {
 const data = [memory('alpha', 'Database port configuration is documented in /srv/alpha/settings.json.'),
  memory('beta', 'Database port configuration is documented in /srv/beta/settings.json.')];
 assert.deepEqual(ids('/srv/unknown/settings.json database port configuration', data), []);
 assert.deepEqual(ids('/srv/beta/settings.json database port configuration', data), ['beta']);
});

test('corpus-independent recall does not penalize politeness as rare evidence', () => {
 for (const size of [0, 10, 150]) {
  const padding = Array.from({ length: size }, (_, i) => memory(`noise-${i}`, `Unrelated astronomy observation ${i}.`));
  assert.deepEqual(ids('Could you please remind me what we discussed about coffee?', [...records, ...padding]), ['coffee']);
 }
});

test('learned aliases match paraphrases without inventing new synonym facts', () => {
 const data = [memory('sketch', '画图之前先列示意草图。', { searchTerms: ['wireframe', 'rough sketch', '示意草图'] }), ...records];
 assert.deepEqual(ids('Do you remember our rough sketch discussion?', data), ['sketch']);
 assert.deepEqual(ids('Do you remember our architectural blueprint discussion?', data), []);
});

test('new explicit subjects override an earlier topic despite conversational wrappers', () => {
 const history = ['数据库相关记忆你还记得吗？', '好的，继续'];
 assert.deepEqual(ids(recallQuery('字体相关记忆你还记得吗？', history)), ['font']);
 assert.deepEqual(ids(recallQuery('继续', ['数据库', '换个话题', '好的'])), []);
 assert.deepEqual(ids(recallQuery('继续', ['咖啡相关记忆你还记得吗？', '好的，谢谢'])), ['coffee']);
});

test('ranking remains evidence-based across body and model alias matches', () => {
 const ranked = rankMemories(records, 'What do you remember about font?', now);
 assert.equal(ranked[0]?.memory.id, 'font');
 assert.equal(ranked[0]?.coverage, 1);
});

const services = [
 memory('sqlite-port', 'SQLite 数据库端口是 5432。'),
 memory('sqlite-auth', 'SQLite 数据库认证使用本地凭据。'),
 memory('postgres-auth', 'PostgreSQL 数据库认证使用独立账户。'),
 memory('redis-timeout', 'Redis 超时是 30 秒。'),
 memory('sqlite-timeout', 'SQLite 超时是 10 秒。'),
];
test('multi-hop attribute refinements retain the subject but require the current facet', () => {
 for (const [prompt, history, expected] of [
  ['端口呢？', ['SQLite 数据库'], 'sqlite-port'],
  ['认证呢？', ['SQLite 数据库', '端口呢？'], 'sqlite-auth'],
  ['继续', ['SQLite 数据库', '端口呢？', '认证呢？', '好的，谢谢'], 'sqlite-auth'],
  ['What about its timeout?', ['SQLite database'], 'sqlite-timeout'],
  ['那 Redis 呢？', ['SQLite 数据库', '端口呢？'], 'redis-timeout'],
 ] as [string, string[], string][]) {
  const plan = resolveRecallQuery(prompt, history);
  assert.deepEqual(selectRelevantMemories(services, plan, 3, now).map(m => m.id), [expected], JSON.stringify(plan));
 }
});

test('unmatched refinement cannot be replaced by old-topic or other-resource matches', () => {
 const query = resolveRecallQuery('超时呢？', ['PostgreSQL 数据库', '认证呢？']);
 assert.deepEqual(selectRelevantMemories(services, query, 3, now), []);
 for (const history of [['SQLite 数据库', '换个话题'], ['SQLite 数据库', 'Kubernetes 网络'], ['SQLite 数据库', '新话题：咖啡']])
  assert.deepEqual(selectRelevantMemories(services, resolveRecallQuery('继续', history), 3, now), []);
});

test('query cleanup preserves exact paths and does not create CJK fragment matches', () => {
 assert.deepEqual([...queryFeatures('/srv/remember/相关记忆.ts')], ['literal:/srv/remember/相关记忆.ts']);
 assert.deepEqual(ids('牙音', [memory('punctuation', '蓝牙。音响配置。')]), []);
 assert.deepEqual(ids('Kubernetes network', [memory('generic', 'The network uses a proxy.')]), []);
});

test('diagnostics explain misses without dumping memory bodies or writing state', () => {
 const data = [memory('right', 'Database port in /srv/right.json is 5432.'), memory('dead', 'Database port.', { status: 'forgotten' })];
 const result = retrieveMemories(data, '/srv/wrong.json database port', 3, now);
 assert.equal(result.diagnostics.excluded, 1);
 assert.equal(result.diagnostics.candidates[0].reason, 'resource-mismatch');
 assert.deepEqual(result.diagnostics.selected, []);
 assert.ok(!JSON.stringify(result.diagnostics).includes('5432'));
 const input = 'password: synthetic-secret\n数据库';
 assert.ok(!queryText(resolveRecallQuery(input)).includes('synthetic-secret'));
 assert.ok(!JSON.stringify(retrieveMemories(data, input, 3, now).diagnostics).includes('synthetic-secret'));
});

test('lifecycle gates and digest trust/size limits survive conversational matching', () => {
 const data = [memory('old', 'Coffee uses oat milk.', { kind: 'project_state', updatedAt: '2020-01-01T00:00:00Z' }),
  memory('forgotten', 'Coffee uses oat milk.', { status: 'forgotten' }), memory('conflict', 'Coffee uses oat milk.', { status: 'conflicted' }),
  memory('live', 'Coffee uses oat milk.', { scope: '/other-origin' })];
 const plan = resolveRecallQuery('What do you remember about coffee?');
 const selected = selectRelevantMemories(data, plan, 3, now);
 assert.deepEqual(selected.map(m => m.id), ['live']);
 const digest = buildRuntimeDigest(selected, plan)!;
 assert.ok(Buffer.byteLength(digest) <= 2048);
 assert.match(digest, /not instructions or authorization/);
 assert.match(digest, /other-origin/);
});

