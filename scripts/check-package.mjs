// Inspect the publishable file set rather than treating a successful dry-run as validation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNpmPack } from './lib/npm-pack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
assert.equal(lock.version, manifest.version, 'lockfile package version drift');
assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies, 'lockfile peer declaration drift');
assert.deepEqual(manifest.pi.extensions, ['./src/index.ts'], 'Pi must discover the current entry point');
assert.ok(manifest.keywords.includes('pi-package'), 'Pi Gallery discovery requires the pi-package keyword');
assert.equal(manifest.pi.image, 'https://raw.githubusercontent.com/btnalit/pi-memory-evolution/main/assets/overview.png');
assert.deepEqual(manifest.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' }, 'publication must target the public npm registry');
for (const name of ['@earendil-works/pi-coding-agent', 'typebox']) {
	assert.equal(manifest.peerDependencies[name], '*', `${name} must be supplied by the Pi host`);
	assert.ok(!manifest.dependencies?.[name], `${name} must not be bundled as a runtime dependency`);
}
const packed = parseNpmPack(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 60_000 }));
const files = new Set(packed.files.map(f => f.path));
for (const path of readdirSync(new URL('../src/', import.meta.url), { recursive: true })) {
	const normalized = path.replaceAll('\\', '/');
	if (normalized.endsWith('.ts') && !normalized.endsWith('.test.ts')) {
		assert.ok(files.has(`src/${normalized}`), `runtime source missing from package: ${normalized}`);
	}
}
for (const required of ['package.json', 'README.md', 'README.cn.md', 'assets/overview.png', 'CHANGELOG.md', 'LICENSE', 'docs/usage.md', 'docs/testing.md', 'docs/releasing.md']) {
	assert.ok(files.has(required), `missing distribution file: ${required}`);
}
for (const path of files) {
	assert.ok(!path.endsWith('.test.ts') && !path.startsWith('node_modules/') && !path.startsWith('scripts/'), `development-only file shipped: ${path}`);
	assert.ok(!/\.(sqlite(?:-wal|-shm)?|jsonl)$/.test(path) && !path.startsWith('.pi/'), `state file shipped: ${path}`);
	if (!path.endsWith('.md')) continue;
	const markdown = readFileSync(`${root}/${path}`, 'utf8');
	for (const match of markdown.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)) {
		const target = match[1].split('#')[0];
		if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
		const resolved = posix.normalize(posix.join(dirname(path).replaceAll('\\', '/'), decodeURIComponent(target)));
		assert.ok(files.has(resolved), `broken/unpackaged documentation link: ${path} -> ${target}`);
	}
}
console.log(`PASS: ${packed.name}@${packed.version}; ${files.size} files; runtime source closure, host peers and documentation links verified.`);
