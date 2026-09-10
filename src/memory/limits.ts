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

/** Which existing records are worth showing the model as replacement candidates.
 * A source is compared to a record by containment — the share of that record's vocabulary the
 * source mentions — not by Jaccard, because a source is orders of magnitude longer than a claim
 * and would score near zero against every one of them.
 * Both numbers are measured on a live 186-memory store, not chosen: at 0.4 a short user cue
 * separates its true subject sharply (0.67-0.80) from everything else (<=0.22), and a long
 * compaction summary saturates instead — it mentions most of the scope — so there the cap and
 * the recency tie-break do the work. Either way the model sees at most MAX_CANDIDATES records
 * instead of every recent one, and only records the source actually talks about. */
export const RELATED_CONTAINMENT = 0.4;
export const MAX_CANDIDATES = 8;

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
export function answerCeiling(modelMaxTokens: unknown): number | undefined {
	return Number.isSafeInteger(modelMaxTokens) && (modelMaxTokens as number) > 0 ? modelMaxTokens as number : undefined;
}
// Worst legal reply on the wire (~56.8 KB: MAX_CLAIMS x (MAX_CLAIM_BYTES + the 1024-byte alias
// budget) plus punctuation), rounded up so pretty-printed but legal output is not rejected.
export const MAX_OUTPUT_BYTES = 64_000;
