# Memory evolution v0.2

## Goal

Automatically improve the extension's own memory with the model already used by Pi.
No approval workflow, secondary agent, external retrieval service, or automated changes
to project/system configuration. Prefer a short, testable path over loosely connected
scoring and proposal subsystems.

## Runtime

1. `session_start`: open/migrate the database lazily and resume at most one eligible
   pending source, choosing the most recently captured one in the current scope.
2. `session_compact`: capture a sanitized, session-qualified source and bounded local
   claims atomically; enqueue automatic semantic consolidation.
3. `agent_end`: capture explicit user memory/correction cues; assistant/tool text does
   not constitute a memory command or an approval. Session/run counts are not gates.
4. `before_agent_start`: retrieve current-directory claims and append a bounded,
   clearly labeled data digest to this turn's system prompt. No model call here.
5. `session_shutdown`: abort background work, drain the serial task chain, close DB.

Factories do not write state or start background work. Processes with a nonempty
`PI_SUBAGENT_AGENT_ID` are skipped; arbitrary child processes are not auto-detected.
Local summary extraction survives LLM failure. User-cue prose is saved as a source,
not locally promoted to claims; learning from it needs a successful model attempt.
There is no recurring full-ledger backfill or periodic job polling.

## Model boundary

`adapter/pi-api.ts` calls Pi 0.85's public
`ctx.modelRegistry.complete(ctx.model, context, options)`. This preserves Pi's model,
provider composition and authentication. The model identity is captured before awaiting
completion, so model switching/reload cannot mislabel its provenance. No credentials are
copied to extension state.

Each input contains a sanitized source (at most 32,000 UTF-8 bytes) and the 32 most
recently updated active claims in that directory, each excerpt capped at 1,440 bytes.
Output is validated JSON (an outer Markdown code fence is tolerated), at most 24,000
bytes and 16 claims of 4–480 UTF-16 code units each. Claim fields are restricted to
`kind`, `content` and optional `replaces`; malformed claims reject the whole model batch.
Only a normal `stop` completion is accepted, not truncated/tool/error output.

Each attempt makes at most one call, with no tools, a 2048-output-token cap, a fresh
request session ID and `cacheRetention: "none"`. A 30-second outer deadline bounds the
extension's wait even if the provider ignores abort. It cannot guarantee cancellation
of remote computation or billing. Retries may therefore incur additional model charges.

A claim can add content or name a specific existing claim to replace. Unknown,
pinned, stale, duplicate-target and cyclic replacements are rejected transactionally.
The stored scope comes from the host, not model output. No model-returned path is
used for file operations. Provisional means model-derived, not awaiting approval.

## Persistence

One SQLite database, WAL + FULL synchronous mode, private database permissions.
`sqlite.ts` selects the bundled Bun or Node SQLite API; no external database package.

- `memories`: current claims, revision/status/layer, source ID, scope and content hash;
  optional `suppressedHashes` preserves correction history across legacy adoption.
- `sources`: sanitized evidence and durable job state/lease/attempt.
- `blocked`: exact-content hashes (outer whitespace trimmed) for forgotten/superseded claims.
- `events`: actual before/after changes, actor, timestamp and source/model reason.
- `metadata`: schema/import marker.

Read/modify/write batches use `BEGIN IMMEDIATE`. No transaction is held during a
network request. Scope generation and job attempt are checked before applying a
completion. Duplicate captures have one source ID. A job lease avoids simultaneous
completion of the same source by multiple Pi processes; abandoned leases expire after
60 seconds. Session start considers pending/expired-running jobs, not failed jobs.
`/memory evolve` also considers failed jobs, selecting at most one most recently captured
eligible source. These operations do not drain the backlog or wait for leases to expire.
Completed jobs do not call the model again; failed attempts are explicitly retryable.

Reads are cached per scope and invalidated by local commits or SQLite `data_version`
when another connection commits. Indexed hashes replace repeated ledger scans. New IDs
hash a JSON tuple of scope/kind/content, not an ambiguous colon concatenation; existing
IDs stay valid. Scope lookup is exact, with no implicit wildcard/global lane.

Memory reads validate the indexed identity/scope/hash against JSON. History/undo validates
before/after shape, paired IDs and unique targets before writing. `/memory status` also
validates source jobs and history. Unknown schema versions are rejected before applying
DDL. These checks detect structural corruption, not all well-formed tampering by a local
user who already has write access to the database.
Undo only succeeds when all affected records still match the event's after state;
newly created records become suppressed tombstones instead of being physically erased.
Undo restores claim state, not the entire database: suppression hashes persist and
source jobs are not reopened. Logical undo/forget is not physical erasure.

## Lifecycle and recall invariants

- **No parent fallback:** raw summaries never participate directly in recall. Their
  claims can be corrected/forgotten/conflicted without another parent path leaking them.
- **No exact resurrection:** automatic extraction does not re-add forgotten content
  under another source ID or kind. Suppression hashes ignore only outer whitespace;
  case, inner whitespace and Unicode literals remain significant. Suppression also retires
  pending/failed sources known to repeat the fact, including formatted repeats beyond
  the normal 16-claim ingestion quota. Explicit correct/undo can restore
  records. Paraphrase equivalence and secure erasure are not guaranteed.
- **No stale overwrite:** changes made while a model request is in flight invalidate
  that result. Older source timestamps cannot replace newer records.
- **No fake authorization:** natural language is not parsed for approve/verified.
  Actual memory transactions replace record-first execution templates.
- **Scoped recall:** canonical cwd only, with no automatic cross-directory inference.
  Unscoped legacy records are not recalled until explicitly assigned.
- **Bounded prompt:** at most 3 distinct claims and 2048 UTF-8 bytes. The historical-data
  guidance is reserved first, with up to 400 bytes per claim excerpt. Each record shows
  ID, kind, status and its stored update date (source date for automatic changes).
  No regenerated 24-hour stamp disguises stale evidence.
- **Literal preservation:** code identifiers, underscores, home paths and globs retain
  their meaning; code spans are protected while removing simple bold labels, and fences
  close only with a matching marker of sufficient length. A heading stack preserves
  progress sibling sections and done/pending/blocked labels.

The deterministic retriever uses Latin/identifier tokens and CJK bigrams. Pinned and
recency scores only break lexical ties; generic continuation may fall back to recency.
Unpinned project-state claims expire from recall after 7 days. Pin/unpin and adoption
preserve the stored evidence date, and undo restores its prior value; the event timestamp
still records when the operation occurred. Facts/preferences/decisions
have no automatic age deletion. Matching excerpts and content dedup improve the small
context budget without embeddings, RRF lanes or a new ranking subsystem.

## Legacy import

Only the memory ledgers are imported, once, without rewriting originals. Invalid
JSON/actions halt import (especially action corruption must not revive old memories).
Legacy summary corrections are applied before deriving a fresh claim revision;
unchanged children survive parent corrections, while explicit child suppression prevents
re-extraction of obsolete facts. New correction history carries exact suppression hashes
into the adopted scope. Old records lacking project metadata enter `legacy`, never a
guessed global/project scope. Already completed imports are not replayed automatically;
these fixes cannot reconstruct information that an earlier import already discarded.

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
  Exact-ID manual commands can intentionally operate on other scopes; this is not a
  multi-user access-control boundary. No public global-memory creation command exists.
- List views are paginated (20 per page), sorted by update time then ID. `all` expands
  the scope; `legacy` enables paginated migration review. Search returns up to 10
  recallable matches, history the latest 10 scope events. No full export command exists;
  concurrent updates may change page boundaries. `show` includes source and timestamps.
- Suppression skips the entire pending model pass of a known repeating source. Local
  claims remain, but unrelated unlearned prose in that source is not independently retried.
- There is no periodic compaction, vector index, learned threshold tuning or rule writer.
- Background completion usage is not incorporated into Pi's normal token accounting.

## Validation

Strict TypeScript, temporary-directory unit/integration tests, real SQLite multi-process
writers, replay/migration/corruption/undo/timeout invariants, and an optional real Pi
RPC test backed by a localhost-only fake OpenAI-compatible model. This host test matters:
Node's built-in SQLite is not available in the standalone Bun binary. The host test
also exercises integrity checks and cleans up child processes/state on startup failure.
Mixed lifecycle sequence tests complement individual examples. Node/npm usage
requires 22.19+ to satisfy Pi 0.85's own engine constraint, even though Node's native
TypeScript support used here is available from 22.18.

No GitHub Actions workflow is installed. `npm run check` and `npm run test:pi` are local
checks; the latter validates host/provider wiring, not actual model quality or multi-day
interactive stability. Installation, upgrade, migration and recovery instructions are
in [README.md](../README.md). See the [follow-up review](review-0.2.md) for reproduced
issues and the validation performed after fixes.
