import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateArtifact } from './release-policy.mjs';

const manifest = JSON.parse(readFileSync('dist/release-manifest.json', 'utf8'));
assert.match(manifest.filename, /^pi-memory-evolution-\d+\.\d+\.\d+\.tgz$/);
validateArtifact(manifest, readFileSync(`dist/${manifest.filename}`), process.env.RELEASE_TAG, process.env.RELEASE_SHA);
assert.equal(process.env.GITHUB_REPOSITORY, 'btnalit/pi-memory-evolution');
const release = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${process.env.RELEASE_TAG}`], { encoding: 'utf8', timeout: 30_000 }));
for (const name of [manifest.filename, 'SHA256SUMS', 'release-manifest.json']) {
	const old = release.assets.find(asset => asset.name === name);
	if (old) {
		const digest = `sha256:${createHash('sha256').update(readFileSync(`dist/${name}`)).digest('hex')}`;
		assert.equal(old.digest, digest, `Existing release asset differs or lacks a digest: ${name}; refusing to overwrite`);
		console.log(`Verified existing release asset: ${name}`);
	} else {
		execFileSync('gh', ['release', 'upload', process.env.RELEASE_TAG, `dist/${name}`, '--repo', process.env.GITHUB_REPOSITORY], { stdio: 'inherit', timeout: 60_000 });
	}
}
