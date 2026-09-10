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

/** What a reply may cost us, derived from the contract above rather than invented. These are
 * reserved locally — for context arithmetic and cost estimation — and are never sent as a ceiling.
 * The ceiling on the wire is the active model's own `maxTokens` (see `adapter/pi-api.ts`): a
 * ceiling is spent on reasoning before any answer is written, so a smaller number of ours can
 * leave a thinking model with no room to answer. How long a model thinks is the provider's
 * business; spend is governed per call, per source and per day by the routing policy. */
// Every claim at its character cap. CJK costs roughly one token per character, so characters
// are the conservative token unit; JSON punctuation and aliases fit in the caller's slack term.
export const MAX_OUTPUT_TOKENS = MAX_CLAIMS * MAX_CLAIM_CHARS;
// Worst legal reply on the wire (~56.8 KB: MAX_CLAIMS x (MAX_CLAIM_BYTES + the 1024-byte alias
// budget) plus punctuation), rounded up so pretty-printed but legal output is not rejected.
export const MAX_OUTPUT_BYTES = 64_000;
