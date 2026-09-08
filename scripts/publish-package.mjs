// Run only in the protected release environment, after CI has built this exact artifact.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicationDecision, registryJson, validateArtifact } from './release-policy.mjs';

const manifest = JSON.parse(readFileSync('dist/release-manifest.json', 'utf8'));
// Validate the filename before reading: an artifact must not select arbitrary local files.
assert.match(manifest.filename, /^pi-memory-evolution-\d+\.\d+\.\d+\.tgz$/);
const archive = resolve('dist', manifest.filename);
validateArtifact(manifest, readFileSync(archive), process.env.RELEASE_TAG, process.env.RELEASE_SHA);
const registry = 'https://registry.npmjs.org/pi-memory-evolution';
const existing = await registryJson(`${registry}/${manifest.version}`);
const catalog = await registryJson(registry);
const decision = publicationDecision(manifest, existing, catalog?.['dist-tags']?.latest);
if (decision === 'already-published') {
	console.log(`Already published: ${manifest.name}@${manifest.version}, exact integrity verified. No tag mutation.`);
} else {
	// No rebuilding, lifecycle scripts or implicit fallback to another registry.
	execFileSync('npm', ['publish', archive, '--access', 'public', '--tag', 'latest', '--provenance', '--ignore-scripts', '--registry', 'https://registry.npmjs.org/'], { stdio: 'inherit', timeout: 120_000 });
	let verified = false;
	for (let attempt = 0; attempt < 6; attempt++) {
		const published = await registryJson(`${registry}/${manifest.version}`);
		if (published) {
			assert.equal(publicationDecision(manifest, published), 'already-published');
			verified = true; break;
		}
		await new Promise(resolve => setTimeout(resolve, 3000));
	}
	assert.ok(verified, 'Publication returned but public registry verification did not complete; retry this release');
	console.log(`Published and anonymously verified ${manifest.name}@${manifest.version}.`);
}
