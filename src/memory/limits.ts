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
