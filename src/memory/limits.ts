/**
 * Bounds shared by the store, the validators, the model-facing prompt and the documentation check.
 * Deliberately import-free so a check script can read it without loading SQLite or the filesystem.
 * A number that appears in two of those places must live here, not be written twice.
 */

/** Storage contract. Older builds reject a newer marker, so a downgrade needs a matching backup. */
export const SCHEMA_VERSION = '7';
/** Every marker this build can open: 2 through the current one, so a bump cannot drop a predecessor. */
export const SUPPORTED_SCHEMAS = Array.from({ length: Number(SCHEMA_VERSION) - 1 }, (_, i) => String(i + 2));
/** Every connection waits this long for a writer instead of failing on the first contended millisecond. */
export const BUSY_TIMEOUT_MS = 5000;

/** One concise claim. Every claim length rule derives from these, so the round trip cannot drift apart. */
export const MAX_CLAIM_CHARS = 800;
export const MIN_CLAIM_CHARS = 4;
// Worst-case UTF-8 for the character cap: an all-CJK claim must survive being fed back as an
// existing candidate uncut, or the model would match `replaces` against a truncated fact.
export const MAX_CLAIM_BYTES = MAX_CLAIM_CHARS * 3;

/** Output shape. The prompt states these to the model and the parser enforces them on its reply, so
 * they must be one value: telling a model one limit and judging it by another burns a paid call. */
export const MAX_CLAIMS = 16;
export const MAX_SEARCH_TERMS = 8;
export const MIN_SEARCH_TERM_CHARS = 2;
export const MAX_SEARCH_TERM_CHARS = 64;

/** Which existing records may be offered to the model as replacement candidates.
 * A record qualifies when the source mentions this share of its vocabulary — containment,
 * not Jaccard, because a source is orders of magnitude longer than a claim and would score
 * near zero against every one of them. Measured on a live 186-memory store: at 0.4 a short
 * user cue separates its true subject (0.67-0.80) sharply from everything else (<=0.22).
 *
 * This is a FILTER and must never become a ranking. Containment is highest for records the
 * source merely restates and lower for the one it contradicts — the changed value is exactly
 * the term that is missing — so ordering by it drops the record that most needs superseding.
 * IDF weighting makes that worse, not better: the missing term is the rare one. Qualifying
 * records therefore keep the original recency order, and the cap below takes the most recent. */
export const RELATED_CONTAINMENT = 0.4;
/** How many qualifying records may be sent. Applied AFTER the containment filter, never before:
 * capping by recency first meant a scope with more than 32 records could never show an older one
 * again, however squarely the source was about it, so it could never be superseded — only
 * accumulated alongside. Measured on a live 89-record scope, 46 relevant records were unreachable
 * that way, including the exact record a user correction was aimed at (rank 63, top containment).
 *
 * Nothing once shown is cut: a record inside the recency top-32 overall is necessarily among the
 * 32 most recent qualifying records, so the old selection is a subset of this one.
 *
 * Residual, deliberately accepted: reach is still bounded by "the 32 most recent that qualify".
 * Containment saturates on long summary sources (38 of 89 records scored 1.00), so in a busy scope
 * the oldest still do not re-enter. Ordering stays by `updatedAt` and must not become recency of
 * confirmation, or records would be shown because they were recently shown. */
export const MAX_CANDIDATES = 32;

/** What a reply may cost us, derived from the contract above rather than invented. These are
 * reserved locally — for context arithmetic and cost estimation — and are never sent as a ceiling.
 * The ceiling on the wire is the active model's own `maxTokens` (see `adapter/pi-api.ts`): a
 * ceiling is spent on reasoning before any answer is written, so a smaller number of ours can
 * leave a thinking model with no room to answer. How long a model thinks is the provider's
 * business; spend is governed per call, per source and per day by the routing policy. */
// Every claim at its character cap. CJK costs roughly one token per character, so characters
// are the conservative token unit; JSON punctuation and aliases fit in the caller's slack term.
export const MAX_OUTPUT_TOKENS = MAX_CLAIMS * MAX_CLAIM_CHARS;
/** The output ceiling for one call: the model's own limit, or nothing when it declares none.
 * Defined once because the number sent to the provider and the number reserved locally for
 * context arithmetic and spend MUST be the same. Reserving less than is asked for lets a payload
 * be packed that leaves no room for the reply the request permits — the provider then rejects the
 * whole call, and a cost ceiling can be overshot by a call that was admitted as cheaper. */
export function answerCeiling(modelMaxTokens: unknown, contextWindow?: unknown): number | undefined {
	if (!Number.isSafeInteger(modelMaxTokens) || (modelMaxTokens as number) <= 0) return undefined;
	// A ceiling no smaller than the window is the catalog's convention for "may use the whole window"
	// (182 of the 1,354 entries in Pi 0.85.1's catalog, every first-party Mistral, Moonshot and xAI
	// model among them), not a number that can be reserved: reserved in full it leaves no room for
	// any input, so every attempt failed locally as context_limit before a request was ever sent.
	// It is treated exactly like a model declaring no limit — nothing is sent, the provider's own
	// default applies, and MAX_OUTPUT_TOKENS is reserved — which keeps "reserve what is sent" intact.
	if (Number.isSafeInteger(contextWindow) && (contextWindow as number) > 0 && (modelMaxTokens as number) >= (contextWindow as number)) return undefined;
	return modelMaxTokens as number;
}
/** A conservative token estimate for context arithmetic. Counting every byte as a token was four
 * times too pessimistic for ASCII and refused calls that fit: on a model whose window is tight but
 * usable, a 24 KB source read as 24,000 tokens against a 20,000-token window. One token per CJK
 * code point (the unit MAX_OUTPUT_TOKENS already assumes) and no more than three bytes per token
 * elsewhere still overestimates real tokenizers on JSON, identifiers and paths, so a payload that
 * passes here fits; it just no longer refuses one that would have. This is not exact tokenization. */
export function estimateTokens(text: string): number {
	let cjk = 0, cjkBytes = 0;
	for (const char of text) if (CJK.test(char)) { cjk++; cjkBytes += Buffer.byteLength(char); }
	return cjk + Math.ceil((Buffer.byteLength(text) - cjkBytes) / 3);
}
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
// Worst legal reply on the wire (~56.8 KB: MAX_CLAIMS x (MAX_CLAIM_BYTES + the 1024-byte alias
// budget) plus punctuation), rounded up so pretty-printed but legal output is not rejected.
export const MAX_OUTPUT_BYTES = 64_000;

/**
 * What makes a stored claim relevant enough to be injected unprompted. A record qualifies on
 * EITHER side, because the two describe different asks and only one of them can answer each.
 *
 * `MIN_FOCUS_COVERAGE` is query-side: the share of the current focus this record accounts for.
 * It is the right question for a recall question ("what is the database port?"), where the whole
 * prompt IS the subject. It is the wrong question for a task prompt, and wrong in a way that gets
 * worse the more the user says: coverage is a fraction of everything asked, so describing the task
 * in two sentences instead of three words divides a relevant record's score by the length of the
 * description. Measured against a realistic store, a 13-word task naming a stored preference by
 * name scored 0.41 and a 57-word one 0.14 — both rejected, while "install dependencies" passed.
 * That is the whole reason automatic injection looked dead outside short questions.
 *
 * The subject side has no share floor, and must not get one. It is carried by NAMING: at least one
 * query feature that names this record's topic — an exact path/filename, or a curated concept
 * synonym or one of the model-written `searchTerms` for the claim that is rare in the store (an
 * everyday alias shared by many records names nothing; retriever.ts) — plus the ordinary multi-match
 * requirement (retriever.ts, 'incidental-overlap' and 'thin-match'). Its first version was the
 * share of the record's own vocabulary the prompt engaged, the asymmetric containment the store uses
 * to pick replacement candidates (`RELATED_CONTAINMENT`). That is invariant to the prompt and
 * dependent on the claim, which the claim contract does not permit: a claim may run to
 * MAX_CLAIM_CHARS characters and carry MAX_SEARCH_TERMS bilingual aliases, so the same two matches
 * that carried a one-line claim were rejected once the claim explained itself, and a record with the
 * full alias budget could not clear the bar on the very aliases written to widen its recall. Every
 * count and share is fixed by what the prompt engages, never by what else the record says.
 *
 * Neither side is the no-filler safeguard on its own. The literal, focus, question-only,
 * subject-attribute, context and thin-match gates run FIRST and are unchanged; the relative cutoff,
 * the three-claim limit and the digest byte cap run after. These only decide whether a record
 * is about the ask at all.
 */
export const MIN_FOCUS_COVERAGE = 0.45;

/** Bytes one REPLAYED history turn may contribute to a query (design.md: "2,048 UTF-8 bytes
 * each"). Enforced once at the source (`adapter/session-context.ts`, before a turn is ever kept)
 * and re-enforced defensively in `memory/query.ts`, so a caller that replays raw context directly
 * cannot exceed it either. This is NOT the bound for the live current-turn prompt below —
 * conflating the two is what MAX_QUERY_BYTES exists to stop. */
export const MAX_HISTORY_TURN_BYTES = 2048;

/** Bytes the LIVE current-turn prompt may reach feature extraction with. A real task description
 * is not a conversational history turn: pasting a stack trace, a diff or a spec ahead of the
 * actual ask routinely runs past MAX_HISTORY_TURN_BYTES. `memory/query.ts` used to clip the live
 * prompt to that same bound before extracting any feature, so a task naming a stored record by
 * name past byte 2048 recalled nothing at all — not a low score, no candidate at all, because the
 * naming words never reached feature extraction. `redact()` and `Intl.Segmenter` already run in
 * full on whatever text is kept, at a two-digit-millisecond cost measured on 100KB input, so this is a
 * pathological-input ceiling a realistic prompt is not expected to reach, not a truncation point. */
export const MAX_QUERY_BYTES = 65_536;
