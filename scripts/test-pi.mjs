// Real Pi/Bun hosts and modelRegistry.complete, using only a loopback fake LLM.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/memory/memory-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'pme-real-pi-'));
const agentDir = join(dir, 'agent');
const stateDir = join(agentDir, 'agent-suite', 'memory-evolution');
const requests = [];
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
		if (semantic) {
			assert.ok(!input.tools?.length, 'memory model must not receive tools');
			const data = JSON.parse(text(input.messages.at(-1).content));
			const port = data.source.content.includes('7777') ? '7777' : '9999';
			answer = JSON.stringify({ memories: [{ kind: 'fact', content: `Database port is ${port}.`, ...(data.existing[0] ? { replaces: data.existing[0].id } : {}) }] });
		}
		const digest = system.includes('# Pi Memory\n') ? system.slice(system.lastIndexOf('# Pi Memory\n')) : '';
		requests.push({ semantic, digest });
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
		const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'memory-test', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
		res.end(chunk({ role: 'assistant', content: answer }, null) + chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }) + 'data: [DONE]\n\n');
	} catch (error) { if (!res.destroyed && !res.headersSent) { res.writeHead(500); res.end(String(error)); } }
});
let child;
let store;
let childClosed = false;
let processError;
let output = '';
let errors = '';
const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
async function waitFor(check) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (processError) throw processError;
		if (childClosed || child.exitCode !== null || child.signalCode !== null) throw new Error(`Pi exited: ${errors}`);
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error(`Timed out. ${errors}\n${output}`);
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
	child = spawn(process.env.PI_TEST_BINARY ?? 'pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-tools', '-e', fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
		cwd, env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SUBAGENT_AGENT_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.on('error', (error) => { processError = error; });
	child.stdin.on('error', (error) => { processError = error; });
	child.on('close', () => { childClosed = true; });
	child.stdout.on('data', (chunk) => output += chunk);
	child.stderr.on('data', (chunk) => errors += chunk);
	send({ id: 'commands', type: 'get_commands' });
	await waitFor(() => output.includes('"name":"memory"'));
}
async function ask(message) {
	const count = (output.match(/"type":"agent_end"/g) ?? []).length;
	send({ type: 'prompt', message });
	await waitFor(() => (output.match(/"type":"agent_end"/g) ?? []).length > count);
	assert.equal(output.includes('extension_error'), false);
	assert.equal(output.includes('"method":"confirm"'), false);
	assert.equal(errors, '');
	return requests.filter((r) => !r.semantic).at(-1).digest;
}
try {
	const projectA = join(dir, 'project-a');
	const projectB = join(dir, 'project-b');
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
		await waitFor(() => store.readMemories().some((m) => m.content.includes(value) && m.status !== 'forgotten'));
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
	assert.match(await ask('继续'), /7777/, 'actual active user context must resolve a followup');
	assert.equal(await ask('Kubernetes networking'), '');
	assert.equal(await ask('继续'), '', 'topic switch must not revive the old database topic');
	send({ type: 'prompt', message: '/memory status' });
	await waitFor(() => output.includes('Recall: all origins') && output.includes('SQLite ok'));
	send({ type: 'prompt', message: `/memory forget ${active[0].id}` });
	await waitFor(() => store.readMemories().every((m) => m.status === 'forgotten'));
	assert.equal(await ask('What is the database port?'), '');
	assert.equal(requests.filter((r) => r.semantic).length, 2);
	assert.equal(requests.filter((r) => !r.semantic).length, 8);
	console.log('PASS: real Pi default model/auth, automatic replacement, fresh cross-directory session recall, contextual followups, topic switch, provenance, forget, no approval.');
} finally {
	store?.close();
	await stopChild();
	server.closeAllConnections();
	if (server.listening) await new Promise((resolve) => server.close(resolve));
	rmSync(dir, { recursive: true, force: true });
}
