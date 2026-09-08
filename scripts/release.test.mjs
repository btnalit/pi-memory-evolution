import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compareVersions, publicationDecision, registryJson, validateArtifact, versionFromTag } from './release-policy.mjs';

const bytes = Buffer.from('Synthetic release archive');
const manifest = { schema: 1, name: 'pi-memory-evolution', version: '0.2.1', commit: 'a'.repeat(40), filename: 'pi-memory-evolution-0.2.1.tgz',
	sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
const existing = { name: manifest.name, version: manifest.version, dist: { integrity: manifest.integrity } };

test('release tags accept only stable versions, not shell input, prereleases or paths', () => {
	assert.equal(versionFromTag('v0.2.1'), '0.2.1');
	for (const tag of ['0.2.1', 'v01.2.1', 'v1.2.3-beta.1', 'v1.2.3\n', 'v1.2.3; echo x', '../v1.2.3', undefined]) assert.throws(() => versionFromTag(tag));
});
test('artifact checks bind name, version, checksum and exact source commit', () => {
	assert.doesNotThrow(() => validateArtifact(manifest, bytes, 'v0.2.1', manifest.commit));
	for (const changed of [{ name: 'other-package' }, { schema: 2 }, { filename: '../../key.conf' }, { commit: 'b'.repeat(40) }, { version: '0.2.2' }, { sha256: '0'.repeat(64) }, { integrity: 'sha512-invalid' }]) {
		assert.throws(() => validateArtifact({ ...manifest, ...changed }, bytes, 'v0.2.1', manifest.commit));
	}
	assert.throws(() => validateArtifact(manifest, Buffer.from('tampered'), 'v0.2.1', manifest.commit));
});
test('an exact existing npm version is idempotent; different bytes never count as success', () => {
	assert.equal(publicationDecision(manifest, existing, '0.3.0'), 'already-published');
	assert.throws(() => publicationDecision(manifest, { ...existing, dist: { integrity: 'different' } }));
	assert.throws(() => publicationDecision(manifest, { ...existing, version: '0.2.2' }));
});
test('new releases cannot move latest backwards', () => {
	assert.equal(publicationDecision(manifest, undefined, '0.2.0'), 'publish');
	assert.equal(publicationDecision(manifest), 'publish');
	for (const latest of ['0.2.1', '0.3.0', 'invalid']) assert.throws(() => publicationDecision(manifest, undefined, latest));
	assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
	assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});
test('registry outages and authentication failures are not treated as unpublished versions', async () => {
	assert.equal(await registryJson('synthetic', async () => ({ status: 404 })), undefined);
	for (const status of [401, 403, 429, 500, 503]) await assert.rejects(registryJson('synthetic', async () => ({ status, ok: false })));
	assert.deepEqual(await registryJson('synthetic', async () => ({ status: 200, ok: true, json: async () => existing })), existing);
});
