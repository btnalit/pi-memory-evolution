// Real Pi/Bun hosts and modelRegistry.complete, using only a loopback fake LLM.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/memory/memory-store.ts';
import { openDatabase } from '../src/memory/sqlite.ts';
import { SCHEMA_VERSION } from '../src/memory/limits.ts';

const dir = mkdtempSync(join(tmpdir(), 'pme-real-pi-'));
const agentDir = join(dir, 'agent');
const stateDir = join(agentDir, 'agent-suite', 'memory-evolution');
const requests = [];
let recoveryCalls = 0;
let longWorkCwd = '';
// Never inherit provider keys: automatic fallback must not discover a live provider in a fixture.
// Git work also must not inherit hooks, repo paths, signing or user configuration.
const fixtureEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
	HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'),
	GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' };
const text = (content) => typeof content === 'string' ? content : content.map((c) => c.text ?? '').join('\n');
const server = createServer(async (req, res) => {
	try {
		let body = '';
		for await (const chunk of req) body += chunk;
		const input = JSON.parse(body);
		const system = input.messages.filter((m) => ['system', 'developer'].includes(m.role)).map((m) => text(m.content)).join('\n');
		const semantic = system.includes('Maintain a small factual memory');
		assert.equal(input.model, 'memory-test');
		assert.equal(req.headers.authorization, 'Bearer synthetic-local-key');
		let answer = 'Noted.';
		let toolCall;
		let toolCalls;
		if (semantic) {
			assert.ok(!input.tools?.length, 'memory model must not receive tools');
			const data = JSON.parse(text(input.messages.at(-1).content));
			if (data.source.id === 'recovery-fixture') {
				assert.equal(input.max_tokens ?? input.max_completion_tokens, 4096, 'cap must respect the model limit');
				answer = ++recoveryCalls === 1 ? 'deliberately invalid JSON' : '{"memories":[]}';
			} else if (data.source.kind === 'user' && data.source.content.startsWith('Our priorities are')) {
				answer = JSON.stringify({ memories: [{ kind: 'preference', content: 'The user prioritizes automatic evolution, relevant injection and automatic recall.' }] });
			} else if (data.source.kind === 'progress' && JSON.parse(data.source.content).request.includes('long-work-fixture')) {
				const evidence = JSON.parse(data.source.content);
				assert.equal(evidence.completion, 'completed');
				assert.equal(evidence.observations.length, 8);
				assert.ok(evidence.observations.some(o => o.tool === 'bash' && o.arguments.includes('git') && o.isError && /No configured push destination/i.test(o.output)), 'early commit/push evidence must survive late diagnostics');
				const target = data.existing.find(m => m.content.includes('project-b long-work-fixture'));
				assert.ok(target, 'bare project-level pending state must be nominated from actual checkout operations');
				answer = JSON.stringify({ memories: [{ kind: 'project_state', content: 'project-b long-work-fixture commit created; push pending; full acceptance remains open.', replaces: target.id }] });
			} else if (data.source.kind === 'progress') {
				const evidence = JSON.parse(data.source.content);
				assert.equal(evidence.observations.at(-1).isError, true);
				assert.match(evidence.observations.at(-1).output, /No configured push destination/i);
				answer = JSON.stringify({ memories: [{ kind: 'project_state', content: 'Fixture commit created; push pending because no remote is configured.', replaces: data.existing[0].id, searchTerms: ['commit', 'push', '提交', '推送'] }] });
			} else {
				const port = data.source.content.includes('7777') ? '7777' : '9999';
				answer = JSON.stringify({ memories: [{ kind: 'fact', content: `Database port is ${port}.`, ...(data.existing[0] ? { replaces: data.existing[0].id } : {}), searchTerms: ['database', 'port', '数据库', '端口', 'service endpoint'] }] });
			}
		} else if (input.messages.at(-1).role === 'user' && text(input.messages.at(-1).content).includes('Continue long-work-fixture.')) {
			const git = 'git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=Fixture -c user.email=fixture@example.invalid';
			toolCalls = [{ index: 0, id: 'long-commit', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `cd ${JSON.stringify(longWorkCwd)} && ${git} add long-fixture.txt && ${git} commit -m long-fixture && ${git} push`, timeout: 15 }) } },
				...Array.from({ length: 12 }, (_,i) => ({ index: i+1, id: `diagnostic-${i}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `printf 'Read-only diagnostic ${i}\\n'` }) } }))];
		} else if (input.messages.at(-1).role === 'user' && text(input.messages.at(-1).content).includes('Use the recall tool fixture.')) {
			assert.ok(input.tools.some(t => t.function?.name === 'memory_recall'), 'read-only recall tool must load in the real host');
			toolCall = { index: 0, id: 'fixture-recall', type: 'function', function: { name: 'memory_recall', arguments: JSON.stringify({ query: 'SQLite 数据库认证' }) } };
		} else if (input.messages.at(-1).role === 'user' && text(input.messages.at(-1).content).includes('Commit fixture changes and push them.')) {
			const git = 'git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=Fixture -c user.email=fixture@example.invalid';
			toolCall = { index: 0, id: 'fixture-commit', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `${git} add fixture.txt && ${git} commit -m fixture-checkpoint && ${git} push`, timeout: 15 }) } };
		} else if (input.messages.at(-1).role === 'tool') answer = 'A local commit was created, but push failed; it is still pending.';
		const digest = system.includes('# Pi Memory\n') ? system.slice(system.lastIndexOf('# Pi Memory\n')) : '';
		requests.push({ semantic, digest, toolResult: input.messages.at(-1).role === 'tool' ? text(input.messages.at(-1).content) : undefined });
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
		const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'memory-test', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
		const outgoingTools = toolCalls ?? (toolCall ? [toolCall] : undefined);
		res.end(chunk(outgoingTools ? { role: 'assistant', tool_calls: outgoingTools } : { role: 'assistant', content: answer }, null) + chunk({}, outgoingTools ? 'tool_calls' : 'stop', { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }) + 'data: [DONE]\n\n');
	} catch (error) { console.error('Synthetic provider assertion:', error.message); if (!res.destroyed && !res.headersSent) { res.writeHead(500); res.end(String(error)); } }
});
let child;
let store;
let childClosed = false;
let processError;
let output = '';
let errors = '';
const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
async function waitFor(check, what = 'condition', timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (processError) throw processError;
		if (childClosed || child.exitCode !== null || child.signalCode !== null) throw new Error(`Pi exited: ${errors}`);
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error(`Timed out waiting for ${what}. ${errors}\n${output}`);
}
async function stopChild() {
	if (!child || childClosed) return;
	const closed = new Promise((resolve) => child.once('close', resolve));
	child.stdin.end();
	const terminate = setTimeout(() => child.kill('SIGTERM'), 1000);
	const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
	try { await closed; } finally { clearTimeout(terminate); clearTimeout(kill); }
}
async function startChild(cwd) {
	output = ''; errors = ''; childClosed = false; processError = undefined;
	child = spawn(process.env.PI_TEST_BINARY ?? 'pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--tools', 'bash,memory_recall', '-e', fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
		cwd, env: { ...fixtureEnv, HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SUBAGENT_AGENT_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.on('error', (error) => { processError = error; });
	child.stdin.on('error', (error) => { processError = error; });
	child.on('close', () => { childClosed = true; });
	child.stdout.on('data', (chunk) => output += chunk);
	child.stderr.on('data', (chunk) => errors += chunk);
	send({ id: 'commands', type: 'get_commands' });
	await waitFor(() => output.includes('"name":"memory"'), 'memory command to register in get_commands response');
}
async function ask(message) {
	const offset = output.length;
	const count = (output.match(/"type":"agent_settled"/g) ?? []).length;
	send({ type: 'prompt', message });
	await waitFor(() => (output.match(/"type":"agent_settled"/g) ?? []).length > count, 'agent_settled event for the prompted turn');
	assert.ok(!output.slice(offset).includes('"stopReason":"error"'), 'foreground model errors are not successful fixture turns');
	assert.ok(output.slice(offset).includes('"stopReason":"stop"'), 'fixture must finish with a normal assistant response');
	assert.equal(output.includes('extension_error'), false);
	assert.equal(output.includes('"method":"confirm"'), false);
	assert.equal(errors, '');
	return requests.filter((r) => !r.semantic).at(-1).digest;
}
try {
	const projectA = join(dir, 'project-a');
	const projectB = join(dir, 'project-b');
	longWorkCwd = projectB;
	for (const path of [agentDir, projectA, projectB]) mkdirSync(path, { recursive: true });
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const port = server.address().port;
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'memory-test': { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'synthetic-local-key', models: [{ id: 'memory-test', reasoning: false, contextWindow: 128000, maxTokens: 4096 }] } } }));
	writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'memory-test', defaultModel: 'memory-test', defaultThinkingLevel: 'off' }));
	await startChild(projectA);
	store = new MemoryStore(stateDir);
	for (const value of ['9999', '7777']) {
		const digest = await ask(`Remember, database port is now ${value}.`);
		if (value === '7777') assert.match(digest, /9999/);
		await waitFor(() => store.readMemories().some((m) => m.content.includes(value) && m.status !== 'forgotten'), `active memory containing port ${value}`);
	}
	const active = store.readMemories().filter((m) => m.status !== 'forgotten');
	assert.equal(active.length, 1);
	assert.match(active[0].content, /7777/);
	await stopChild();

	// Fresh Pi process + different cwd, sharing only the memory DB (no session history).
	await startChild(projectB);
	assert.equal(await ask('继续'), '', 'no topic must not recall arbitrary newest memories');
	const recalled = await ask('What is the database port?');
	assert.match(recalled, /7777/);
	assert.ok(recalled.includes(realpathSync(projectA)), 'origin must follow the claim, not the current cwd');
	assert.ok(recalled.includes(active[0].sourceEntryId));
	assert.ok(Buffer.byteLength(recalled) <= 2048);
	assert.match(await ask('数据库端口是多少？'), /7777/, 'Chinese query must retrieve the English fact');
	assert.match(await ask('service endpoint'), /7777/, 'model search aliases must work in the real Bun host');
	assert.match(await ask('继续'), /7777/, 'actual active user context must resolve a followup');
	assert.match(await ask('数据库相关记忆你还能记得吗？'), /7777/, 'conversational framing must not dilute the subject');
	assert.match(await ask('Do you still remember our database discussion?'), /7777/);
	assert.match(await ask('端口呢？'), /7777/, 'a new facet must inherit the database topic');
	assert.match(await ask('继续'), /7777/, 'chained followups must retain the subject and focus');
	assert.equal(await ask('What do you remember about narwhals?'), '');
	assert.equal(await ask('继续'), '', 'an unknown subject must not fall back to the previous matched topic');
	send({ type: 'prompt', message: '/memory explain' });
	await waitFor(() => output.includes('Last automatic recall snapshot'), "/memory explain output containing 'Last automatic recall snapshot'");
	assert.equal(await ask('Kubernetes networking'), '');
	assert.equal(await ask('继续'), '', 'topic switch must not revive the old database topic');
	send({ type: 'prompt', message: '/memory status' });
	await waitFor(() => output.includes('Recall: all origins') && output.includes('SQLite ok'), "/memory status output containing 'Recall: all origins' and 'SQLite ok'");
	send({ type: 'prompt', message: `/memory forget ${active[0].id}` });
	await waitFor(() => store.readMemories().every((m) => m.status === 'forgotten'), '/memory forget to retire all memories');
	assert.equal(await ask('What is the database port?'), '');
	assert.equal(requests.filter((r) => r.semantic).length, 2);
	assert.equal(requests.filter((r) => !r.semantic).length, 16);

	// Real local Git commit + intentionally failed push, not an assistant-only success claim.
	execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-b', 'main'], { cwd: projectB, env: { ...fixtureEnv, HOME: dir }, stdio: 'pipe' });
	writeFileSync(join(projectB, 'fixture.txt'), 'Synthetic test data only.\n');
	store.capture({ id: 'fixture-state', scope: realpathSync(projectB), kind: 'summary', content: '## Progress\n- Fixture changes are not committed or pushed.', createdAt: new Date().toISOString() });
	store.finishEvolution(store.beginEvolution('fixture-state'), [], 'fixture-seed');
	const oldProgress = store.readMemories().find((m) => m.kind === 'project_state' && m.status !== 'forgotten');
	await ask('Commit fixture changes and push them.');
	await waitFor(() => store.readMemories().some((m) => m.sourceEntryId.startsWith('progress:') && m.status !== 'forgotten'), 'progress-sourced memory recording commit/push status');
	assert.equal(store.readMemories().find((m) => m.id === oldProgress.id).status, 'forgotten');
	const progressDigest = await ask('Fixture commit push status?');
	assert.match(progressDigest, /commit created; push pending/);
	assert.ok(!progressDigest.includes('are not committed'));
	assert.equal(requests.filter((r) => r.semantic).length, 3);
	assert.equal(requests.filter((r) => !r.semantic).length, 19);
	store.capture({ id: 'facet-fixture', scope: '/synthetic-other-origin', kind: 'summary', content: '## Critical Context\n- SQLite 数据库认证使用本地凭据。\n- SQLite 数据库超时是 10 秒。\n- PostgreSQL 数据库认证使用独立账户。', createdAt: new Date().toISOString() });
	store.finishEvolution(store.beginEvolution('facet-fixture'), [], 'fixture-seed');
	await ask('SQLite 数据库');
	const authDigest = await ask('认证呢？');
	assert.match(authDigest, /本地凭据/); assert.ok(!authDigest.includes('独立账户')); assert.ok(!authDigest.includes('10 秒'));
	const timeoutDigest = await ask('超时呢？');
	assert.match(timeoutDigest, /10 秒/); assert.ok(!timeoutDigest.includes('凭据'));
	assert.match(await ask('继续'), /10 秒/);
	assert.equal(requests.filter((r) => r.semantic).length, 3, 'ordinary recall questions must not spend a learning call');
	// New evidence labels, explicit feedback, and a real mid-task recall tool round trip.
	assert.match(progressDigest, /tool_observation\/model/);
	const beforeLookup = store.readMemories(); const beforeHistory = store.history();
	await ask('Use the recall tool fixture.');
	const lookup = requests.at(-1).toolResult;
	assert.equal(typeof lookup, 'string', `Recall tool round trip missing: ${output.slice(-6000)}`);
	assert.match(lookup, /本地凭据/); assert.match(lookup, /summary\/local/); assert.ok(Buffer.byteLength(lookup) <= 2048);
	assert.deepEqual(store.readMemories(), beforeLookup); assert.deepEqual(store.history(), beforeHistory);
	assert.equal(requests.filter(r => r.semantic).length, 3, 'read-only tool must not trigger paid evolution');
	const authMemory = store.readMemories().find(m => m.content.includes('SQLite 数据库认证'));
	send({ type: 'prompt', message: `/memory feedback ${authMemory.id} useful` });
	await waitFor(() => store.readMemories().find(m => m.id === authMemory.id).feedback?.utility?.verdict === 'useful', `/memory feedback recording 'useful' on ${authMemory.id}`);
	assert.equal(store.readMemories().find(m => m.id === authMemory.id).updatedAt, authMemory.updatedAt);
	await ask(`记忆 ${authMemory.id} 错误。`);
	await waitFor(() => store.readMemories().find(m => m.id === authMemory.id).status === 'conflicted', `memory ${authMemory.id} to become conflicted after error feedback`);
	assert.equal(await ask('SQLite 数据库认证'), '');
	assert.equal(requests.filter(r => r.semantic).length, 3, 'exact-ID feedback is local, not another model call');
	assert.match(store.status(), new RegExp(`schema ${SCHEMA_VERSION}`));

	const callsBeforePipeline = requests.filter(r => r.semantic).length;
	await ask('Our priorities are automatic evolution, relevant injection and automatic recall.');
	await waitFor(() => store.readMemories().some(m => m.kind === 'preference' && m.content.includes('prioritizes automatic evolution')), "preference memory containing 'prioritizes automatic evolution'");
	assert.equal(requests.filter(r => r.semantic).length, callsBeforePipeline+1, 'natural requirements learn without a remember cue');
	writeFileSync(join(projectB, 'long-fixture.txt'), 'Synthetic long work fixture.\n');
	store.capture({ id: 'long-state', scope: realpathSync(projectB), kind: 'summary', content: '## Progress\n- project-b long-work-fixture commit and push pending; full acceptance remains open.', createdAt: '2020-01-01T00:00:00Z' });
	store.finishEvolution(store.beginEvolution('long-state'), [], 'fixture-seed');
	const longOld = store.readMemories().find(m => m.sourceEntryId === 'long-state');
	await ask('Continue long-work-fixture.');
	await waitFor(() => store.readMemories().find(m => m.id === longOld.id).status === 'forgotten', `long-work memory ${longOld.id} to be retired`);
	const longDigest = await ask('project-b long-work-fixture');
	assert.match(longDigest, /commit created; push pending/); assert.match(longDigest, /acceptance remains open/);
	assert.equal(requests.filter(r => r.semantic).length, callsBeforePipeline+2);
	send({ type: 'prompt', message: '/memory learning' });
	await waitFor(() => output.includes('Last learning capture') && output.includes('changedRecords='), "/memory learning output containing 'Last learning capture' and 'changedRecords='");

	// A persisted failure is picked up on startup, then a malformed response retries
	// on the real recurring timer with no user prompt or /memory evolve command.
	await stopChild();
	store.capture({ id: 'recovery-fixture', kind: 'user', scope: '/other-origin', content: 'Remember SQLite storage.', createdAt: new Date().toISOString() });
	store.failEvolution(store.beginEvolution('recovery-fixture'), 'timeout', Date.now() - 120_000);
	await startChild(projectA);
	await waitFor(() => store.status().includes('invalid_output'), "recovered store status to include 'invalid_output' after startup replay");
	assert.equal(recoveryCalls, 1);
	// The extension is running and may hold the write lock; openDatabase applies the store's own wait.
	const db = openDatabase(join(stateDir, 'memory.sqlite'));
	try { db.exec("UPDATE sources SET retry_at=0 WHERE id='recovery-fixture'"); } finally { db.close(); }
	await waitFor(() => recoveryCalls === 2 && !store.status().includes('failed='), 'second recovery attempt to succeed on the recurring timer', 25_000);
	assert.match(store.status(), /retrying=0, paused=0/);
	assert.equal(output.includes('extension_error'), false);
	console.log('PASS: natural requirement capture, early commit/push evidence after 12 diagnostics, project-name update nomination, partial acceptance preserved, learning diagnostics, evidence labels, feedback/quarantine without paid learning, read-only memory_recall round trip, real Pi model/auth, cross-session recall, natural-language questions, multi-hop focus/subject matching, unknown-topic barriers, explain diagnostics, no recall-time learning calls, topic switch, provenance, forget, tool-backed progress update, failed push not called success, automatic startup/timer recovery, no approval.');
} finally {
	store?.close();
	await stopChild();
	server.closeAllConnections();
	if (server.listening) await new Promise((resolve) => server.close(resolve));
	rmSync(dir, { recursive: true, force: true });
}
