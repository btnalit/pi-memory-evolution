import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
export function versionFromTag(tag) {
	assert.equal(typeof tag, 'string');
	assert.ok(tag.startsWith('v') && stable.test(tag.slice(1)), 'Expected a stable vX.Y.Z tag');
	return tag.slice(1);
}
export function compareVersions(a, b) {
	assert.ok(stable.test(a) && stable.test(b), 'Expected stable versions');
	const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
	for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
	return 0;
}
export function validateArtifact(manifest, bytes, tag, sha) {
	assert.equal(manifest.schema, 1);
	assert.equal(manifest.name, 'pi-memory-evolution');
	assert.equal(manifest.version, versionFromTag(tag));
	assert.match(sha, /^[a-f0-9]{40}(?![\s\S])/);
	assert.equal(manifest.commit, sha, 'Archive does not belong to the verified release commit');
	assert.equal(manifest.filename, `pi-memory-evolution-${manifest.version}.tgz`, 'Unsafe/mismatched archive filename');
	assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'), 'Archive SHA-256 mismatch');
	assert.equal(manifest.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`, 'Archive integrity mismatch');
}
export function publicationDecision(manifest, existing, latest) {
	if (existing) {
		assert.equal(existing.name, manifest.name);
		assert.equal(existing.version, manifest.version);
		assert.equal(existing.dist?.integrity, manifest.integrity, 'Existing npm version has different contents; never overwrite it');
		return 'already-published';
	}
	if (latest) assert.ok(compareVersions(manifest.version, latest) > 0, 'Refusing to move latest backwards or reuse its version');
	return 'publish';
}
export async function registryJson(url, request = fetch) {
	const response = await request(url, { signal: AbortSignal.timeout(20_000) });
	if (response.status === 404) return undefined;
	assert.ok(response.ok, `Registry returned HTTP ${response.status}; this is not an unpublished version`);
	return response.json();
}
