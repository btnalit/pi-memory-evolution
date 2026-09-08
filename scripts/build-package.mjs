import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateArtifact } from './release-policy.mjs';
import { parseNpmPack } from './lib/npm-pack.mjs';

execFileSync(process.execPath, ['scripts/check-package.mjs'], { stdio: 'inherit' });
const out = resolve('dist');
mkdirSync(out, { recursive: true });
assert.ok(readdirSync(out).every(name => ['release-manifest.json', 'SHA256SUMS'].includes(name) || /^pi-memory-evolution-\d+\.\d+\.\d+\.tgz$/.test(name)), 'Unexpected files in dist');
const pack = parseNpmPack(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], { encoding: 'utf8', timeout: 60_000 }));
const bytes = readFileSync(resolve(out, pack.filename));
const manifest = { schema: 1, name: pack.name, version: pack.version,
	commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
	filename: pack.filename, sha256: createHash('sha256').update(bytes).digest('hex'),
	integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
assert.equal(pack.integrity, manifest.integrity);
validateArtifact(manifest, bytes, `v${manifest.version}`, manifest.commit);
const otherArchives = readdirSync(out).filter(name => name.endsWith('.tgz') && name !== pack.filename);
assert.equal(otherArchives.length, 0, 'Remove old dist archives explicitly before building a different version');
writeFileSync(resolve(out, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(resolve(out, 'SHA256SUMS'), `${manifest.sha256}  ${manifest.filename}\n`);
console.log(`Built ${manifest.filename} from ${manifest.commit}; checksums recorded.`);
