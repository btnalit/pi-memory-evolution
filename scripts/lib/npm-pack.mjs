import assert from 'node:assert/strict';

/** npm <=11 returns an array; npm 12 returns an object keyed by package name. */
export function parseNpmPack(output, expectedName = 'pi-memory-evolution') {
	let raw;
	try { raw = JSON.parse(output.toString()); }
	catch { throw new Error('npm pack returned invalid JSON'); }
	assert.ok(raw && typeof raw === 'object', 'npm pack must return an array or package-name map');
	const entries = Array.isArray(raw) ? raw : Object.values(raw);
	assert.equal(entries.length, 1, 'Expected exactly one npm pack result; refusing empty or multi-package output');
	const packed = entries[0];
	assert.ok(packed && typeof packed === 'object' && !Array.isArray(packed), 'Invalid npm pack entry');
	assert.equal(packed.name, expectedName, 'npm pack returned a different package');
	if (!Array.isArray(raw)) assert.equal(Object.keys(raw)[0], packed.name, 'npm pack map key does not match its entry');
	assert.equal(typeof packed.version, 'string');
	assert.ok(packed.version.length > 0, 'Missing npm pack version');
	assert.equal(typeof packed.filename, 'string');
	assert.match(packed.filename, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$(?![\s\S])/, 'Unsafe npm pack archive filename');
	assert.ok(Array.isArray(packed.files), 'Missing npm pack file list');
	return packed;
}
