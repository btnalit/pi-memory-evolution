// Documentation states numbers that only the code can be right about. This has shipped wrong twice:
// a README told users to expect a schema marker two versions behind, so a correct install looked broken.
// check-package.mjs verifies that documentation *links* resolve; this verifies what documentation *claims*.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	MAX_CLAIMS, MAX_CLAIM_BYTES, MAX_CLAIM_CHARS, MIN_CLAIM_CHARS,
	MAX_SEARCH_TERMS, MAX_SEARCH_TERM_CHARS, MIN_SEARCH_TERM_CHARS, SCHEMA_VERSION,
} from '../src/memory/limits.ts';

const files = ['README.md', 'README.cn.md', ...readdirSync('docs').filter(f => f.endsWith('.md')).map(f => join('docs', f))];
const read = new Map(files.map(f => [f, readFileSync(f, 'utf8')]));
const group = (n) => Number(n).toLocaleString('en-US'); // docs write 2,400 rather than 2400
const failures = [];
const check = (file, text, found, expected, what) => {
	if (String(found) !== String(expected)) failures.push(`${file}: ${what} says ${found}, code says ${expected}\n    ${text.trim().slice(0, 120)}`);
};

// 1. Statements about the *current* version. These are what a user compares their own output against,
//    so they are never allowed to lag; there is no legitimate reason for them to name an older marker.
const CURRENT = [
	[/SQLite ok \(schema (\d+)\)/g, SCHEMA_VERSION, 'status output'],
	[/reject schema (\d+)/g, SCHEMA_VERSION, 'rejection notice'],
	[/upgrades? transactionally to \**(\d+)/gi, SCHEMA_VERSION, 'upgrade target'],
];
for (const [file, body] of read) {
	for (const line of body.split('\n')) {
		for (const [pattern, expected, what] of CURRENT) {
			for (const m of line.matchAll(pattern)) check(file, line, m[1], expected, what);
		}
	}
}

// 2. Every other mention of a schema number. Naming an older one is legitimate when describing what a
//    migration starts from, so those are allowed — but only by explicit entry, so new prose forces a
//    decision instead of silently drifting. Keep `why` accurate; it is the whole value of the list.
const HISTORICAL = [
	['docs/progress-pipeline.md', 'keeps schema 5', 'records what the unreleased 0.2.0 follow-up did at the time'],
	['docs/testing.md', 'schema-6 scheduling migration', 'names the version being upgraded from'],
	['docs/core-quality.md', 'schema-4 migration', 'names the version being upgraded from'],
	['docs/design.md', 'schema-2-through-6-to-7 upgrade', 'spells out the supported upgrade range'],
	['docs/design.md', 'from the actual schema-3 table shape', 'describes a fixture reconstructing an old shape'],
	['docs/core-quality.md', 'Schema 2/3/4/5/6 upgrades transactionally to', 'lists the versions upgraded from; the target is checked above'],
	['docs/quality-validation.md', 'Schema-2-to-3 upgrade tests', 'names a historical upgrade path covered by tests'],
];
for (const [file, body] of read) {
	for (const line of body.split('\n')) {
		for (const m of line.matchAll(/schema[ -](\d+)/gi)) {
			if (m[1] === SCHEMA_VERSION) continue;
			// The entry must name the very mention it excuses, so a second unvetted number sharing the
			// line is still reported rather than covered by its neighbour's exemption.
			const allowed = HISTORICAL.some(([f, phrase]) => f === file && line.includes(phrase)
				&& phrase.toLowerCase().includes(m[0].toLowerCase()));
			if (!allowed) failures.push(`${file}: mentions schema ${m[1]}, current is ${SCHEMA_VERSION}. If it names a version being\n`
				+ `    upgraded *from*, add it to HISTORICAL in this script with a reason; otherwise correct it.\n    ${line.trim().slice(0, 120)}`);
		}
	}
}
for (const [file, phrase, why] of HISTORICAL) {
	assert.ok(why, `HISTORICAL entry for ${file} needs a reason`);
	assert.ok(read.get(file)?.includes(phrase), `Stale HISTORICAL entry: ${file} no longer contains "${phrase}" — remove it`);
}

// 3. Bounds a reader may act on: what they may type, and what they use to reason about payload size.
//    Anchored on stable surrounding wording rather than a bare number, so a match is unambiguous.
const BOUNDS = [
	['docs/usage.md', /literal replacement, (\d+)–(\d+) characters/, [MIN_CLAIM_CHARS, MAX_CLAIM_CHARS], 'correct command bounds'],
	['docs/design.md', /and (\d+) claims of (\d+)–(\d+) UTF-16 code units/, [MAX_CLAIMS, MIN_CLAIM_CHARS, MAX_CLAIM_CHARS], 'claim shape'],
	['docs/design.md', /each capped at ([\d,]+) bytes/, [group(MAX_CLAIM_BYTES)], 'existing-claim clip'],
];
for (const [file, pattern, expected, what] of BOUNDS) {
	const body = read.get(file);
	assert.ok(body, `${file} is listed in BOUNDS but was not read`);
	const m = body.match(pattern);
	assert.ok(m, `${file}: ${what} — anchor ${pattern} no longer matches. The sentence was reworded; update this check with it.`);
	expected.forEach((value, i) => check(file, m[0], m[i + 1], value, what));
}

// 4. The prompt is documentation too: it tells the model bounds the parser then judges its reply by.
//    They are one constant now, and this asserts the rendered prompt still says so.
const prompt = readFileSync('src/memory/evolution.ts', 'utf8');
for (const [needle, what] of [
	[`At most \${MAX_CLAIMS} claims, each \${MIN_CLAIM_CHARS}-\${MAX_CLAIM_CHARS} characters.`, 'claim bounds'],
	[`up to \${MAX_SEARCH_TERMS} concise English AND Chinese searchTerms per claim (\${MIN_SEARCH_TERM_CHARS}-\${MAX_SEARCH_TERM_CHARS} characters each)`, 'search-term bounds'],
]) assert.ok(prompt.includes(needle), `evolution.ts PROMPT no longer interpolates its ${what}; a literal number there can drift from the validator`);

assert.ok(MAX_CLAIM_BYTES === MAX_CLAIM_CHARS * 3, 'MAX_CLAIM_BYTES must stay worst-case UTF-8 for MAX_CLAIM_CHARS');
assert.ok(MAX_SEARCH_TERM_CHARS > MIN_SEARCH_TERM_CHARS && MAX_CLAIM_CHARS > MIN_CLAIM_CHARS, 'bounds inverted');

if (failures.length) {
	console.error(`FAIL: ${failures.length} documented constant(s) disagree with the code:\n\n` + failures.join('\n\n') + '\n');
	process.exit(1);
}
console.log(`PASS: documented constants match the code across ${files.length} files; ${HISTORICAL.length} historical mentions allowed by name.`);
