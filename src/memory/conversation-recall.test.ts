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


// A task prompt is the normal way a coding session starts, and it is longer than a recall question
// by nature. Relevance was measured only as the share of the prompt a record accounted for, so the
// same record that matched "install dependencies" stopped matching once the same request was
// written as a sentence. Nothing here is newly stored; it is what was already stored being offered.
const project = [
 memory('deps', 'The user prefers pnpm over npm for installing dependencies in all projects.', { kind: 'preference', searchTerms: ['pnpm', 'npm', 'package manager'] }),
 memory('billing', 'We decided to use Postgres instead of MySQL for the billing service.', { kind: 'decision', searchTerms: ['postgres', 'mysql', 'billing'] }),
 memory('staging', 'The staging database listens on port 7777 and requires TLS.', { searchTerms: ['database', 'port', 'staging'] }),
 memory('style', 'The user wants concise answers with no filler and code that matches the surrounding style.', { kind: 'preference', searchTerms: ['concise', 'style'] }),
];
const task = 'I want to add a new endpoint to the API server for exporting invoices as CSV. It should stream the\n'
 + 'response so large exports do not blow up memory, and it needs to respect the existing authentication\n'
 + 'middleware. Please also add tests. Before you start, install the dependencies in this repo so the test\n'
 + 'suite can run.';

test('a record the task engages is injected however long the task description is', () => {
 for (const prompt of ['install dependencies', 'Add a CSV export endpoint to the API server and install dependencies first.', task])
  assert.deepEqual(ids(prompt, project), ['deps'], prompt);
 assert.deepEqual(ids('Can you help me set up the database connection for the staging environment?', project), ['staging']);
 assert.deepEqual(ids('Let us continue working on the billing service migration. Which database did we settle on?', project), ['billing']);
});

// The records above are on disjoint topics, so they cannot show what the subject side rejects —
// only what it admits. A real store is full of unrelated short claims that share an everyday word
// or two with any given task, and two coincidental matches are exactly as many as the two that
// are a claim's actual topic, and score no lower. These are the records that must NOT come back.
const clutter = [
 memory('badge', 'Badge access to the server room needs security approval.'),
 memory('onboarding', 'New hires get repo access on their first day.'),
 memory('standup', 'Standup is at 9:15 and should run no longer than ten minutes.'),
 memory('lunch', 'Lunch orders need to be submitted before eleven.'),
 memory('keys', 'Spare keys are held by reception, not by the server room.'),
 memory('bikes', 'Bike storage is in the basement and needs a fob.'),
 memory('coffee-machine', 'The office coffee machine needs descaling every month.'),
 memory('printer', 'The printer on the third floor jams with thick paper.'),
 memory('recycling', 'Paper recycling goes in the blue bins on each floor.'),
 memory('visitors', 'Visitors must be signed in at the front desk.'),
];

test('length-invariant relevance does not turn a long task prompt into unrelated filler', () => {
 for (const prompt of ['Please review this pull request and tell me whether the approach is sound.',
  'Refactor the payment retry loop to use exponential backoff.', 'What is the weather like in Oslo today?',
  'Rewrite this function so it reads better.'])
  assert.deepEqual(ids(prompt, project), [], prompt);
 // Against clutter, the long task must still return exactly the record it is about. 'badge' and
 // 'onboarding' are the two engaged on coincidence alone — server+needs and new+repo — and they
 // outscore nothing, so only a match that NAMES a topic can separate them.
 const store = [...project, ...clutter];
 const diagnostics = retrieveMemories(store, resolveRecallQuery(task), 3, now).diagnostics;
 assert.deepEqual(diagnostics.selected, ['deps']);
 const reasons = new Map(diagnostics.candidates.map(c => [c.id, c.reason]));
 for (const id of ['badge', 'onboarding']) assert.equal(reasons.get(id), 'incidental-overlap', id);
 // They are engaged on as many features as the record that IS selected, so no count of matches
 // can be what rejected them; only the topic-match requirement can be, and that is the point.
 const matches = new Map(diagnostics.candidates.map(c => [c.id, c.matches.length]));
 for (const id of ['badge', 'onboarding']) assert.ok(matches.get(id)! >= matches.get('deps')!, id);
 const digest = buildRuntimeDigest(selectRelevantMemories(store, resolveRecallQuery(task), 3, now), resolveRecallQuery(task), now)!;
 assert.match(digest, /pnpm/);
 assert.ok(!/Postgres|7777|concise|Badge|hires/u.test(digest));
 assert.ok(Buffer.byteLength(digest) <= 2048);
});

test('an everyday word shared with a short claim is not a topic, in any store size', () => {
 const store = [...project, ...clutter];
 // Shorter prompts must not regress into the same coincidence, and a prompt about the clutter
 // itself must still reach it: the requirement is about naming a topic, not about suppression.
 assert.deepEqual(ids('Add a CSV export endpoint to the API server and install dependencies first.', store), ['deps']);
 assert.deepEqual(ids('Who approves access to the server room?', store).includes('badge'), true);
});

test('multilingual incidental overlap cannot displace a named subject', () => {
 const relevant = memory('deps-bilingual', 'The user prefers pnpm over npm for installing dependencies in all projects.', {
  kind: 'preference', searchTerms: ['pnpm', 'npm', 'package manager', '包管理器', '依赖安装'],
 });
 const unrelated = [
  memory('ops-cn', '仓库中的服务需要运行，日志由值班人员查看。'),
  memory('files-cn', '文件需要整理，模块名称要保持一致，仓库管理员负责记录。'),
 ];
 const prompt = '请在仓库中安装依赖并运行测试；before you start, install the dependencies in this repository and run the test suite.';
 const result = retrieveMemories([relevant, ...unrelated], resolveRecallQuery(prompt), 3, now);
 assert.deepEqual(result.diagnostics.selected, ['deps-bilingual']);
 const reasons = new Map(result.diagnostics.candidates.map(candidate => [candidate.id, candidate.reason]));
 for (const id of unrelated.map(record => record.id)) {
  assert.equal(reasons.get(id), 'incidental-overlap', id);
  assert.ok(!result.selected.some(record => record.id === id), id);
 }
});

// The price of the topic-match requirement, pinned so it is paid knowingly. A record with no
// aliases whose subject is not in the concept vocabulary has nothing that NAMES its topic, so on a
// long prompt it is indistinguishable from the clutter above and is deliberately not reachable on
// the subject side. It stays reachable when the prompt is mostly about it, and evolution asks the
// model for aliases even on unchanged facts, so the gap closes for any record that gets evolved.
test('an alias-less record outside the concept vocabulary is reachable by query coverage, not by subject', () => {
 const indent = memory('indent', 'The user prefers tabs over spaces for indentation.', { kind: 'preference' });
 const store = [...project, ...clutter, indent];
 const long = 'Reformat this module so it reads better, keep the public signatures as they are, and use tabs for\n'
  + 'indentation like the rest of the tree. Then add a short comment above each exported function.';
 const candidate = retrieveMemories(store, resolveRecallQuery(long), 3, now).diagnostics.candidates.find(c => c.id === 'indent')!;
 assert.equal(candidate.reason, 'incidental-overlap');
 assert.ok(candidate.coverage < 0.45, 'the query side does not carry it either; this is the subject-side price');
 assert.deepEqual(ids('tabs or spaces for indentation?', store), ['indent']);
 // One model-written alias is enough to name the topic, which is what evolution supplies.
 assert.deepEqual(ids(long, [...project, ...clutter, { ...indent, searchTerms: ['indentation', '缩进'] }]), ['indent']);
});

// Nor may relevance depend on how much the CLAIM says. The first subject-side measure was the share
// of the record's own vocabulary the prompt engaged: invariant to the prompt, but a claim may run to
// 800 characters and carry eight bilingual aliases, so the same two matches that carried a one-line
// claim were rejected once the claim explained itself — and once the model had written the full
// alias budget for it, the aliases that named the topic pushed it under the bar. What the prompt
// engages decides; what else the record says does not.
test('the same engagement carries a claim whatever its length or alias count, however long the prompt', () => {
 const verbose = memory('deps-verbose', 'The user prefers pnpm over npm for installing dependencies in all projects, because its lockfile is\n'
  + 'stricter, its store is shared across checkouts, and CI restores it faster.',
  { kind: 'preference', searchTerms: ['pnpm', 'npm', 'package manager', 'install dependencies', 'lockfile', 'workspace', '包管理器', '依赖安装'] });
 const rest = [...project.filter(m => m.id !== 'deps'), ...clutter];
 const sentence = 'Add a CSV export endpoint to the API server and install dependencies first.';
 for (const [record, prompt] of [[project[0], sentence], [project[0], task], [verbose, sentence], [verbose, task]] as const) {
  const diagnostics = retrieveMemories([...rest, record], resolveRecallQuery(prompt), 3, now).diagnostics;
  assert.deepEqual(diagnostics.selected, [record.id], `${record.id} on: ${prompt.slice(0, 40)}`);
  const candidate = diagnostics.candidates.find(c => c.id === record.id)!;
  assert.deepEqual(candidate.matches, ['concept:installation', 'dependencies'], 'both claims are engaged on exactly the same two features');
  assert.ok(candidate.coverage < 0.45, 'and neither prompt is mostly about the record, so the subject side is what carries it');
 }
 // The negative half: length is not what keeps clutter out either. A long note sharing the same two
 // everyday words with the task as the short badge note is rejected for the same reason it is —
 // it names no topic — not for being long.
 const verboseBadge = memory('badge-verbose', 'Badge access to the server room needs security approval; the request form is on the\n'
  + 'intranet under facilities and approvals take two working days.');
 const diagnostics = retrieveMemories([...rest, project[0], verboseBadge], resolveRecallQuery(task), 3, now).diagnostics;
 assert.deepEqual(diagnostics.selected, ['deps']);
 const reasons = new Map(diagnostics.candidates.map(c => [c.id, c.reason]));
 assert.equal(reasons.get('badge-verbose'), 'incidental-overlap');
 assert.equal(reasons.get('badge'), 'incidental-overlap');
});

// A live task prompt is not a conversational history turn, and it is routinely longer than one:
// a pasted stack trace, diff or spec ahead of the actual ask commonly runs past a single turn's
// bound. query.ts once clipped the live prompt to the same 2,048-byte budget the bounded
// REPLAYED HISTORY uses, so a task naming a stored record by name past byte 2048 recalled nothing
// at all — not a low score, no candidate at all, because the naming words never reached feature
// extraction. The two must stay separate bounds: MAX_HISTORY_TURN_BYTES governs replayed context,
// MAX_QUERY_BYTES the live prompt.
test('a topic named past the history byte budget is still recalled from a live task prompt', () => {
 const filler = 'This is unrelated background context describing the repository layout and prior incidents. '.repeat(30);
 assert.ok(Buffer.byteLength(filler) > 2048, 'the fixture must actually exceed the history-turn budget');
 const late = `${filler}Before you start, please install the dependencies for this repo so the test suite can run.`;
 const store = [...project, ...clutter];
 assert.deepEqual(ids(late, store), ['deps']);
 // The real hook (index.ts) calls resolveRecallQuery(event.prompt, recentUserMessages(ctx)), and
 // Pi may already include the live turn in that history (query.ts's own comment on the dedup
 // check says so). That self-copy must not shadow the live prompt's larger budget with its own
 // history-clipped one: the topic must still be found this way, not only through the bare-string
 // helper that never exercises recentUsers.
 assert.deepEqual(selectRelevantMemories(store, resolveRecallQuery(late, [late]), 3, now).map(m => m.id), ['deps']);
 // A positive control first, so the negative half below actually discriminates: a short prior
 // turn does let a topic-less 'continue' inherit its subject in this codebase.
 assert.deepEqual(selectRelevantMemories(store, resolveRecallQuery('continue', [task]), 3, now).map(m => m.id), ['deps']);
 // Only the LIVE prompt's budget grew. The same long text replayed as a PRIOR turn, rather than
 // asked directly, still loses its topic past the unchanged 2,048-byte history-turn bound, so a
 // topic-less follow-up after it cannot inherit 'deps' — proving the two budgets stayed separate
 // rather than the history bound being widened too.
 assert.deepEqual(selectRelevantMemories(store, resolveRecallQuery('continue', [late]), 3, now).map(m => m.id), []);
});

// The widened live-prompt budget admits far more DISTINCT words than one repeated sentence does,
// and diverse text is the realistic risk: a pasted log or spec has hundreds of different tokens,
// any of which could coincidentally overlap a clutter record. Reusing clutter's own vocabulary at
// length is the adversarial case — if the topic-match requirement only ever saw short clutter
// notes, widening the prompt budget could let a long, wordy one accumulate enough incidental
// overlap to look engaged. It must not: naming a topic, not overlap volume, is still what admits
// a record, however many distinct words the now-longer prompt contributes.
test('a long, vocabulary-diverse prompt still cannot admit clutter it never names as a topic', () => {
 const officeLog = [
  'Badge access to the server room needs security approval from facilities before anyone new is added.',
  'New hires get repo access on their first day, along with a desk assignment and a laptop.',
  'Standup is at 9:15 and should run no longer than ten minutes, ideally in the small meeting room.',
  'Lunch orders need to be submitted before eleven or the vendor will not deliver on time.',
  'Spare keys are held by reception, not by the server room, in case anyone gets locked out.',
  'Bike storage is in the basement and needs a fob; ask facilities if yours does not work.',
  'The office coffee machine needs descaling every month or the espresso starts tasting off.',
  'The printer on the third floor jams with thick paper, so use the one near the kitchen instead.',
  'Paper recycling goes in the blue bins on each floor, separate from general waste.',
  'Visitors must be signed in at the front desk and given a temporary badge for the day.',
 ].join(' ');
 const filler = Array.from({ length: 6 }, (_, i) => `${officeLog} Note ${i}: none of this is the actual task.`).join(' ');
 assert.ok(Buffer.byteLength(filler) > 2048, 'the fixture must actually exceed the history-turn budget');
 const late = `${filler} Before you start, please install the dependencies for this repo so the test suite can run.`;
 const store = [...project, ...clutter];
 const diagnostics = retrieveMemories(store, resolveRecallQuery(late), 3, now).diagnostics;
 assert.deepEqual(diagnostics.selected, ['deps']);
 const clutterIds = new Set(clutter.map(m => m.id));
 for (const candidate of diagnostics.candidates) if (clutterIds.has(candidate.id)) assert.equal(candidate.reason, 'incidental-overlap', candidate.id);
});
