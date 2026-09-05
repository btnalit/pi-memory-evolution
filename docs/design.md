# Memory evolution v0.2

## Goal

Automatically improve the extension's own memory with the model already used by Pi.
No approval workflow, secondary agent, external retrieval service, or automated changes
to project/system configuration. Prefer a short, testable path over loosely connected
scoring and proposal subsystems.

## Runtime

1. `session_start`: open/migrate the database lazily and resume a pending source.
2. `session_compact`: capture a sanitized, session-qualified source and bounded local
   claims atomically; enqueue automatic semantic consolidation.
3. `agent_end`: capture explicit user memory/correction cues; assistant/tool text does
   not constitute a memory command or an approval. Session/run counts are not gates.
4. `before_agent_start`: retrieve current-directory claims and append a bounded,
   clearly labeled data digest to this turn's system prompt. No model call here.
5. `session_shutdown`: abort background work, drain the bounded task chain, close DB.

Factories do not write state or start background work. Subagent processes are skipped.
Local extraction survives LLM failure; free prose can be learned by the model but is
not guessed by the heading parser. There is no recurring full-ledger backfill.

## Model boundary

`adapter/pi-api.ts` calls Pi 0.85's public
`ctx.modelRegistry.complete(ctx.model, context, options)`. This preserves Pi's model,
provider composition and authentication. No credentials are copied to extension state.

Each input contains a sanitized source (at most 32 KB) and at most 32 active claims in
that directory. Output is strict JSON, at most 16 claims of 4–480 characters. The request
has no tools, a 2048-output-token cap, a fresh request session ID, no cache retention
request, and a 30-second outer deadline that also bounds providers ignoring abort.

A claim can add content or name a specific existing claim to replace. Unknown,
pinned, stale, duplicate-target and cyclic replacements are rejected transactionally.
The stored scope comes from the host, not model output. No model-returned path is
used for file operations. Provisional means model-derived, not awaiting approval.

## Persistence

One SQLite database, WAL + FULL synchronous mode, private database permissions.
`sqlite.ts` selects the bundled Bun or Node SQLite API; no external database package.

- `memories`: current claims, revision/status/layer, source ID, scope and content hash.
- `sources`: sanitized evidence and durable job state/lease/attempt.
- `blocked`: exact-content hashes (outer whitespace trimmed) for forgotten/superseded claims.
- `events`: actual before/after changes, actor, timestamp and source/model reason.
- `metadata`: schema/import marker.

Read/modify/write batches use `BEGIN IMMEDIATE`. No transaction is held during a
network request. Scope generation and job attempt are checked before applying a
completion. Duplicate captures have one source ID. A job lease avoids simultaneous
completion of the same source by multiple Pi processes; abandoned leases expire.
Completed jobs do not call the model again; failed jobs are explicitly retryable.

Reads are cached per scope and invalidated by local commits or SQLite `data_version`
when another connection commits. Indexed hashes replace repeated ledger scans.
Undo only succeeds when all affected records still match the event's after state;
newly created records become suppressed tombstones instead of being physically erased.

## Lifecycle and recall invariants

- **No parent fallback:** raw summaries never participate directly in recall. Their
  claims can be corrected/forgotten/conflicted without another parent path leaking them.
- **No exact resurrection:** forgotten content is not re-added under another source ID
  or kind. Manual suppression also retires its pending source. Paraphrase equivalence
  is not guaranteed; do not advertise logical forget as secure erasure.
- **No stale overwrite:** changes made while a model request is in flight invalidate
  that result. Older source timestamps cannot replace newer records.
- **No fake authorization:** natural language is not parsed for approve/verified.
  Actual memory transactions replace record-first execution templates.
- **Scoped recall:** canonical cwd only, with no automatic cross-directory inference.
  Unscoped legacy records are not recalled until explicitly assigned.
- **Bounded prompt:** at most 3 distinct claims and 2048 UTF-8 bytes. The historical-data
  guidance is reserved first. Each record shows ID, kind, status and actual update date.
  No regenerated 24-hour stamp disguises stale evidence.
- **Literal preservation:** code identifiers, underscores, home paths and globs retain
  their meaning; project-state extraction keeps done/pending/blocked labels.

The deterministic retriever uses Latin/identifier tokens and CJK bigrams. Pinned and
recency scores only break lexical ties; generic continuation may fall back to recency.
Unpinned project-state claims expire from recall after 7 days. Facts/preferences/decisions
have no automatic age deletion. Matching excerpts and content dedup improve the small
context budget without embeddings, RRF lanes or a new ranking subsystem.

## Legacy import

Only the memory ledgers are imported, once, without rewriting originals. Invalid
JSON/actions halt import (especially action corruption must not revive old memories).
Legacy summary corrections are applied before deriving a fresh claim revision;
mutated children suppress re-extraction from their old parent. Old records lacking
project metadata enter `legacy`, never a guessed global/project scope.

Signals, agenda, speak gate, thresholds, proposals, executor/archive and unused
utilization computation were removed from the code path and source tree. Existing
historical files remain untouched. They are not migrated into automatic actions.

## Known limits

- Model inference can still be wrong. Provenance, provisional labels, pin, correct and
  undo are recovery controls, not proof of truth.
- Sanitization is conservative but not exhaustive. Sources are sent only through the
  selected Pi provider; this is not fully offline semantic learning.
- Raw evidence/history grows until deliberately managed. No automatic purge or physical
  secret erasure is claimed; back up with Pi stopped.
- Scope is cwd, not repo/branch identity. Moving a project does not infer its new scope.
- There is no periodic compaction, vector index, learned threshold tuning or rule writer.
- Background completion usage is not incorporated into Pi's normal token accounting.

## Validation

Strict TypeScript, temporary-directory unit/integration tests, real SQLite multi-process
writers, replay/migration/corruption/undo/timeout invariants, and an optional real Pi
RPC test backed by a localhost-only fake OpenAI-compatible model. This host test matters:
Node's built-in SQLite is not available in the standalone Bun binary.
