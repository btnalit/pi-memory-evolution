// Real Pi package management and default discovery, with no public network/model calls.
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MemoryStore } from '../src/memory/memory-store.ts';
import { openDatabase } from '../src/memory/sqlite.ts';
import { SCHEMA_VERSION } from '../src/memory/limits.ts';
import { parseNpmPack } from './lib/npm-pack.mjs';

process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pme-install-'));
const agentDir = join(dir, 'agent'), cwd = join(dir, 'work');
const stateDir = join(agentDir, 'agent-suite', 'memory-evolution');
const settingsFile = join(agentDir, 'settings.json');
const binary = process.env.PI_TEST_BINARY ?? 'pi';
const pi = binary.includes('/') || binary.includes('\\') ? resolve(binary) : binary;
// A whitelist avoids inheriting provider keys, Git overrides, npm credentials and preloads.
const env = {
	PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
	HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'),
	PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_SUBAGENT_AGENT_ID: '',
	GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: join(dir, 'gitconfig'), GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
	GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
	npm_config_userconfig: join(dir, 'npmrc'), npm_config_globalconfig: join(dir, 'global-npmrc'),
	npm_config_cache: join(dir, 'npm-cache'), npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
	npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
};
const run = (command, args, work = cwd, overrides = {}) => execFileSync(command, args, { cwd: work, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
// Package subcommands reject --offline. PI_OFFLINE also makes explicit updates a
// silent no-op, so enable only that command; Git is still file-only and npm offline.
const runPi = (...args) => run(pi, args, cwd, args[0] === 'update' ? { PI_OFFLINE: '0' } : {});
const packages = () => JSON.parse(readFileSync(settingsFile, 'utf8')).packages ?? [];
const sourceOf = entry => typeof entry === 'string' ? entry : entry.source;
const git = (...args) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], origin);
let child, closed = true, error, buffer = '', events = [], serial = 0, stderr = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, what = 'condition') {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (error) throw error;
		assert.ok(!closed, `Pi exited unexpectedly: ${stderr}`);
		const value = fn(); if (value) return value;
		await pause(25);
	}
	// A bounded tail of what was actually scanned, not the whole buffer.
	const seen = JSON.stringify(events.slice(-20)).slice(-4000);
	throw new Error(`RPC timeout waiting for ${what}: ${stderr}\nLast ${Math.min(20, events.length)} of ${events.length} events: ${seen}`);
}
async function rpc(type, fields = {}) {
	const id = String(++serial);
	child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
	const reply = await waitFor(() => events.find(e => e.type === 'response' && e.id === id), `response to ${type} (id=${id})`);
	assert.equal(reply.success, true, `RPC rejected ${type}`);
	return reply.data;
}
async function stop() {
	if (!child || closed) return;
	const finished = new Promise(resolve => child.once('close', resolve));
	child.stdin.end();
	const term = setTimeout(() => child.kill('SIGTERM'), 1000), kill = setTimeout(() => child.kill('SIGKILL'), 3000);
	try { await finished; } finally { clearTimeout(term); clearTimeout(kill); }
}
async function smoke(expectedEntry) {
	closed = false; error = undefined; buffer = ''; events = []; stderr = '';
	// No -e or --no-extensions: exercise normal installed-package discovery, not a wrapper.
	child = spawn(pi, ['--mode', 'rpc', '--no-session', '--offline', '--no-approve', '--no-context-files', '--no-skills', '--no-prompt-templates'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
	child.on('error', e => { error = e; }); child.stdin.on('error', e => { error = e; });
	child.on('close', () => { closed = true; });
	child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		buffer += chunk;
		while (buffer.includes('\n')) {
			const i = buffer.indexOf('\n'); const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
			if (!line) continue;
			let event; try { event = JSON.parse(line); } catch { error = new Error('Invalid RPC JSONL'); continue; }
			events.push(event);
			if (event.type === 'extension_error') error = new Error('Installed extension failed');
			if (event.type === 'agent_start') { error = new Error('A diagnostic command unexpectedly started a model turn'); child.kill('SIGTERM'); }
			if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(event.method)) error = new Error('Unexpected interactive installation prompt');
		}
	});
	try {
		const commands = (await rpc('get_commands')).commands.filter(c => c.name === 'memory');
		assert.equal(commands.length, expectedEntry ? 1 : 0, 'installed command must load exactly once, or disappear after removal');
		if (expectedEntry) {
			assert.equal(commands[0].source, 'extension');
			// Extension command paths are optional in the public RPC response.
			if (commands[0].path) assert.equal(realpathSync(commands[0].path), realpathSync(expectedEntry));
			assert.ok(existsSync(expectedEntry));
			for (const [command, expected] of [['status', new RegExp(`SQLite ok \\(schema ${SCHEMA_VERSION}\\)`)], ['learning', /Last learning capture/], ['explain', /Last automatic recall snapshot/]]) {
				const offset = events.length;
				await rpc('prompt', { message: `/memory ${command}` });
				await waitFor(() => events.slice(offset).some(e => e.type === 'extension_ui_request' && e.method === 'notify' && expected.test(e.message)), `/memory ${command} notify output matching ${expected}`);
			}
		}
		assert.ok(!events.some(e => e.type === 'extension_ui_request' && e.notifyType === 'warning'), 'extension warning during clean startup/diagnostics');
	} finally { await stop(); }
}
const stateSnapshot = () => {
	const db = openDatabase(join(stateDir, 'memory.sqlite'));
	try {
		assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema'").get().value, SCHEMA_VERSION);
		assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
		return JSON.stringify(['memories', 'sources', 'events', 'metadata', 'blocked', 'feedback_receipts'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
	} finally { db.close(); }
};
const origin = join(dir, 'origin');
let registry;
try {
	for (const path of [agentDir, cwd]) mkdirSync(path, { recursive: true });
	for (const name of ['gitconfig', 'npmrc', 'global-npmrc']) writeFileSync(join(dir, name), '');
	writeFileSync(settingsFile, JSON.stringify({ packages: [], defaultProjectTrust: 'never', enableInstallTelemetry: false }));
	console.log(`Host: ${run(pi, ['--version']).trim()}; Node: ${process.version}; npm: ${run('npm', ['--version']).trim()}`);
	const packed = parseNpmPack(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], root));
	const extracted = join(dir, 'package files'); mkdirSync(extracted);
	run('tar', ['-xzf', join(dir, packed.filename), '-C', extracted]);
	const local = join(extracted, 'package');
	assert.ok(!existsSync(join(local, 'node_modules')), 'tarball must load without checkout dependencies');
	runPi('install', local); runPi('install', local);
	assert.equal(packages().length, 1, 'repeat local installation must not duplicate settings');
	assert.ok(runPi('list').includes('package'));
	assert.ok(runPi('list', '--approve').includes('package'), 'documented trusted-project listing flag must work');
	await smoke(join(local, 'src/index.ts'));
	console.log('PASS: packed artifact installs idempotently and loads through normal Pi discovery without node_modules.');

	// Synthetic tracked state, with its source already settled: startup must not need a model.
	const store = new MemoryStore(stateDir);
	try {
		store.capture({ id: 'install-fixture', scope: '/synthetic-install-origin', kind: 'summary', content: '## Constraints & Preferences\n- Installation fixtures use isolated local state.', createdAt: '2026-01-01T00:00:00Z' });
		store.finishEvolution(store.beginEvolution('install-fixture'), [], 'synthetic-install-seed');
		assert.equal(store.readMemories().length, 1);
	} finally { store.close(); }
	const snapshot = stateSnapshot();
	runPi('remove', local); assert.equal(packages().length, 0);
	await smoke(); assert.equal(stateSnapshot(), snapshot, 'uninstall must preserve memory state/history');

	// Exercise the real Git installer/update path using only file transport. Keep the real
	// manifest + lockfile; npm runs normally, offline and without lifecycle scripts or caches.
	cpSync(local, origin, { recursive: true });
	cpSync(join(root, 'package-lock.json'), join(origin, 'package-lock.json'));
	git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'installation fixture');
	const first = git('rev-parse', 'HEAD').trim();
	git('tag', 'fixture-v1');
	const source = 'https://install-fixture.invalid/example/pi-memory-evolution';
	env.GIT_CONFIG_COUNT = '1';
	env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(origin).href}.insteadOf`;
	env.GIT_CONFIG_VALUE_0 = source;
	const checkout = join(agentDir, 'git', 'install-fixture.invalid', 'example', 'pi-memory-evolution');
	runPi('install', source); runPi('install', source);
	assert.equal(packages().length, 1);
	assert.equal(run('git', ['rev-parse', 'HEAD'], checkout).trim(), first);
	await smoke(join(checkout, 'src/index.ts'));
	assert.equal(stateSnapshot(), snapshot, 'switching sources must retain records');
	console.log('PASS: native Git installation, real offline npm dependency step, repeat installation and source switch.');

	writeFileSync(join(origin, 'fixture-update.txt'), 'Synthetic update only.\n');
	git('add', 'fixture-update.txt'); git('commit', '-m', 'fixture update');
	const latest = git('rev-parse', 'HEAD').trim();
	runPi('update', source);
	assert.equal(run('git', ['rev-parse', 'HEAD'], checkout).trim(), latest);
	assert.ok(existsSync(join(checkout, 'fixture-update.txt')));
	await smoke(join(checkout, 'src/index.ts'));
	assert.equal(stateSnapshot(), snapshot);

	runPi('install', `${source}@fixture-v1`);
	assert.equal(packages().length, 1);
	assert.equal(run('git', ['rev-parse', 'HEAD'], checkout).trim(), first);
	runPi('install', source);
	assert.equal(packages().length, 1);
	assert.equal(sourceOf(packages()[0]), source);
	assert.equal(run('git', ['rev-parse', 'HEAD'], checkout).trim(), latest, 'removing an old pin must follow the default branch');
	await smoke(join(checkout, 'src/index.ts'));
	assert.equal(stateSnapshot(), snapshot);
	runPi('remove', source); assert.equal(packages().length, 0);
	await smoke(); assert.equal(stateSnapshot(), snapshot);
	console.log('PASS: update, old-pin transition, removal and preserved schema-' + SCHEMA_VERSION + ' records/history.');

	// Native npm installation against a loopback registry serving the actual tarball.
	// No peer packages are served: the Pi host must supply its own APIs and TypeBox.
	const manifest = JSON.parse(readFileSync(join(local, 'package.json'), 'utf8'));
	const archive = readFileSync(join(dir, packed.filename));
	const registryRequests = [];
	let baseUrl;
	registry = createServer((request, response) => {
		registryRequests.push({ method: request.method, url: request.url });
		if (request.method === 'GET' && request.url === `/${manifest.name}`) {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: {
				...manifest, dist: { tarball: `${baseUrl}/fixture.tgz`, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` },
			} } }));
		} else if (request.method === 'GET' && request.url === '/fixture.tgz') {
			response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(archive);
		} else { response.writeHead(404); response.end('{}'); }
	});
	await new Promise((resolve, reject) => { registry.once('error', reject); registry.listen(0, '127.0.0.1', resolve); });
	baseUrl = `http://127.0.0.1:${registry.address().port}`;
	const npmPi = async (...args) => promisify(execFile)(pi, args, { cwd, env: { ...env, npm_config_offline: 'false', npm_config_registry: baseUrl, npm_config_cache: join(dir, 'registry-cache') }, timeout: 60_000 });
	const npmSource = `npm:${manifest.name}`;
	await npmPi('install', npmSource); await npmPi('install', npmSource);
	assert.equal(packages().length, 1);
	assert.equal(sourceOf(packages()[0]), npmSource);
	const npmEntry = join(agentDir, 'npm', 'node_modules', manifest.name, 'src/index.ts');
	await smoke(npmEntry); assert.equal(stateSnapshot(), snapshot);
	assert.ok(registryRequests.some(r => r.url === '/fixture.tgz'), 'native npm must fetch the actual archive');
	assert.ok(registryRequests.every(r => r.method === 'GET' && [ `/${manifest.name}`, '/fixture.tgz' ].includes(r.url)), `unexpected registry dependency/request: ${JSON.stringify(registryRequests)}`);
	// Different source forms are intentionally distinct Pi packages. Reproduce the
	// reported fatal collision, then verify CLI removal works without starting Pi.
	runPi('install', local); assert.equal(packages().length, 2);
	await assert.rejects(smoke(npmEntry), /memory_recall|duplicate/i, 'mixed sources must expose the real host conflict');
	runPi('remove', local); assert.equal(packages().length, 1);
	assert.equal(sourceOf(packages()[0]), npmSource);
	await smoke(npmEntry); assert.equal(stateSnapshot(), snapshot, 'duplicate-source recovery must retain memory/history');
	await npmPi('remove', npmSource); assert.equal(packages().length, 0);
	await smoke(); assert.equal(stateSnapshot(), snapshot);
	console.log('PASS: native npm install/reinstall/remove and mixed-source conflict recovery; no bundled host peers.');
	console.log('PASS: installation smoke test; isolated credentials/settings/state, no public network or model requests.');
} finally {
	await stop();
	if (registry) { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)); }
	rmSync(dir, { recursive: true, force: true });
}
