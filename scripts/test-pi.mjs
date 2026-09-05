// Real Pi/Bun host + real modelRegistry.complete, but a loopback-only fake LLM.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/memory/memory-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'pme-real-pi-'));
const agentDir = join(dir, 'agent');
const stateDir = join(agentDir, 'agent-suite', 'memory-evolution');
mkdirSync(agentDir, { recursive: true });
const requests = [];
const text = (content) => typeof content === 'string' ? content : content.map((c) => c.text ?? '').join('\n');
const server = createServer(async (req, res) => {
	let body = '';
	for await (const chunk of req) body += chunk;
	try {
		const input = JSON.parse(body);
		const semantic = input.messages.some((m) => text(m.content).includes('Maintain a small factual memory'));
		assert.equal(input.model, 'memory-test');
		assert.equal(req.headers.authorization, 'Bearer synthetic-local-key');
		let answer = 'Noted.';
		if (semantic) {
			assert.ok(!input.tools?.length, 'memory model must not receive tools');
			const data = JSON.parse(text(input.messages.at(-1).content));
			const port = data.source.content.includes('7777') ? '7777' : '9999';
			answer = JSON.stringify({ memories: [{ kind: 'fact', content: `Database port is ${port}.`, ...(data.existing[0] ? { replaces: data.existing[0].id } : {}) }] });
		}
		requests.push({ model: input.model, semantic });
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
		const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'memory-test', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
		res.end(chunk({ role: 'assistant', content: answer }, null) + chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }) + 'data: [DONE]\n\n');
	} catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'memory-test': { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'synthetic-local-key', models: [{ id: 'memory-test', reasoning: false, contextWindow: 128000, maxTokens: 4096 }] } } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'memory-test', defaultModel: 'memory-test', defaultThinkingLevel: 'off' }));
const child = spawn(process.env.PI_TEST_BINARY ?? 'pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-tools', '-e', fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
	cwd: dir, env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
let output = '';
let errors = '';
child.stdout.on('data', (chunk) => output += chunk);
child.stderr.on('data', (chunk) => errors += chunk);
const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
async function waitFor(check) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Pi exited: ${errors}`);
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error(`Timed out. ${errors}\n${output}`);
}
let store;
try {
	send({ id: 'commands', type: 'get_commands' });
	await waitFor(() => output.includes('"name":"memory"'));
	store = new MemoryStore(stateDir);
	for (const value of ['9999', '7777']) {
		send({ id: value, type: 'prompt', message: `Remember, database port is now ${value}.` });
		await waitFor(() => store.readMemories().some((m) => m.content.includes(value) && m.status !== 'forgotten'));
	}
	const active = store.readMemories().filter((m) => m.status !== 'forgotten');
	assert.equal(active.length, 1);
	assert.match(active[0].content, /7777/);
	assert.equal(requests.filter((r) => r.semantic).length, 2);
	assert.equal(requests.filter((r) => !r.semantic).length, 2);
	assert.equal(output.includes('"method":"confirm"'), false);
	assert.equal(output.includes('extension_error'), false);
	assert.equal(errors, '');
	console.log('PASS: real Pi host, default model + authentication reused, two automatic updates, no approval, old memory retired.');
} finally {
	store?.close();
	child.stdin.end();
	await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(() => { child.kill(); resolve(); }, 2000))]);
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(dir, { recursive: true, force: true });
}
