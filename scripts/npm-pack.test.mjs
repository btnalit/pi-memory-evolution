import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNpmPack } from './lib/npm-pack.mjs';

const entry = { name: 'pi-memory-evolution', version: '0.2.1', filename: 'pi-memory-evolution-0.2.1.tgz',
	files: [{ path: 'package.json', size: 123 }], integrity: 'sha512-synthetic', size: 1234 };

test('npm 10/11 arrays and npm 12 package maps normalize to the same complete entry', () => {
	assert.deepEqual(parseNpmPack(JSON.stringify([entry])), entry);
	assert.deepEqual(parseNpmPack(JSON.stringify({ [entry.name]: entry })), entry);
	assert.deepEqual(parseNpmPack(Buffer.from(JSON.stringify([entry]))), entry);
});
test('pack output rejects empty or ambiguous results instead of silently picking a package', () => {
	for (const raw of [[], {}, [entry, entry], { first: entry, second: entry }]) assert.throws(() => parseNpmPack(JSON.stringify(raw)));
});
test('pack output rejects invalid JSON, scalar roots and invalid entries', () => {
	for (const text of ['not JSON', 'null', '0', '"package"', '[null]', '[[]]', '[42]', '{"pi-memory-evolution":null}']) {
		assert.throws(() => parseNpmPack(text));
	}
});
test('pack output validates package identity, metadata and safe flat filenames', () => {
	assert.throws(() => parseNpmPack(JSON.stringify({ wrongKey: entry })));
	for (const changed of [{ name: 'other' }, { version: '' }, { version: 1 }, { filename: '../private.tgz' }, { filename: '/tmp/pkg.tgz' }, { filename: 'pkg.tgz\n' }, { files: null }]) {
		assert.throws(() => parseNpmPack(JSON.stringify([{ ...entry, ...changed }])));
	}
});
