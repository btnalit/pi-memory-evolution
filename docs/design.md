# Memory evolution v0.2

## Goal

Automatically improve memory with Pi's active model, then recall relevant claims across
sessions and directories. Directory placement must not determine which memories a
conversation can use. No approval workflow, secondary agent, external retrieval service
or automatic changes to project files, system configuration, skills or extension code.

## Runtime

1. `session_start`: open/migrate lazily and resume at most one most recently captured
   eligible pending source across all origins.
2. `session_compact`: atomically capture a sanitized session-qualified source and bounded
   local claims; enqueue semantic consolidation.
3. `agent_end`: capture explicit user memory/correction cues. Assistant/tool text is not
   a memory command or approval; session/run counts are not gates.
4. `before_agent_start`: resolve the current topic, search the whole memory database and
   append a bounded, source-labeled digest to this turn's system prompt. No model call.
5. `session_shutdown`: abort work, drain the serial task chain and close SQLite.

Factories do not write state or start background work. Processes with a nonempty
`PI_SUBAGENT_AGENT_ID` are skipped. There is no recurring full-ledger backfill, periodic
job polling or scanning of arbitrary historical Pi session files.

## Conversation-aware recall

`adapter/session-context.ts` uses the public `buildContextEntries()` facade, not session
files or `getEntries()` across branches. It examines up to 64 trailing active entries
(and up to 64 retained-tail messages per compaction), selecting at most 6 user texts of
2,048 UTF-8 bytes each. Retained user tails survive compaction. Assistant/tool/custom and
injected messages are excluded, as are raw compaction summaries. Context is transient:
it is never re-captured as a source. Missing/invalidated context leaves direct-query
recall available rather than poisoning the hook.

A topic-less follow-up inherits the nearest identifiable recent user topic. Short related
follow-ups can add that topic as context. Explicit new subjects stand alone; reset phrases
stop inheritance. If neither the prompt nor recent users identify a topic, recall is empty.
A fresh session saying only `continue` cannot identify what to continue; naming a subject
can retrieve its memory even if it was learned in another directory/session.

All stored claims, including `legacy` imports, are candidates. Retrieval remains local
and deterministic: Latin/identifier terms and CJK bigrams. Common words such as `没有`
cannot qualify a claim, and weak configuration terms alone are insufficient. Origin
basename matches help rank named contexts. Current-origin preference, pinning and dates
only break relevance ties; there is **no arbitrary recency fallback** or requirement to
fill all three slots. These are lexical heuristics, not semantic query rewriting or
exhaustive pronoun resolution.

The digest contains at most 3 claims within 2,048 UTF-8 bytes, with historical-data trust
guidance reserved first. Each JSON row includes ID, kind, status, origin, source ID,
stored update date and a matching excerpt of up to 400 bytes. Oversized metadata labels
are clipped with an ellipsis/hash suffix. Origins are provenance hints, not evidence
that another project's fact applies here. Identical content is deduplicated only within
one origin: equal port/path text from different contexts can mean different facts.

Forgotten/conflicted claims never recall. Unpinned project-state claims expire from recall
after 7 days; facts/preferences/decisions have no automatic age deletion. Pin/unpin and
legacy annotation preserve the evidence date, and undo restores the prior date. Event
history separately records when an operation occurred.

## Model boundary and conservative writes

`adapter/pi-api.ts` calls Pi 0.85's public
`ctx.modelRegistry.complete(ctx.model, context, options)`, preserving model/provider/auth
resolution. Model identity is captured before awaiting completion, so switching models
or invalidating a context cannot mislabel provenance. No credentials are copied to state.

Each input contains a sanitized source (at most 32,000 bytes) and up to 32 recently updated
active claims **from that source origin**, each capped at 1,440 bytes. This deliberately
limits automatic replacement authority, **not recall eligibility**. One origin can cover
multiple projects. The prompt requires an explicitly identifiable same subject/fact and
preservation of project/resource qualifications; matching cwd alone is not identity.

Output is validated JSON (an outer Markdown fence is tolerated), at most 24,000 bytes
and 16 claims of 4–480 UTF-16 code units each. Fields are restricted to `kind`, `content`
and optional `replaces`; malformed claims reject the batch. Unknown, cross-origin, pinned,
stale, duplicate-target and cyclic replacements are rejected transactionally. Only normal
`stop` completion is accepted, never truncated/tool/error output. Model paths are not
used for file operations, and model claims remain `provisional`, not awaiting approval.

Each attempt uses at most one model call, no tools, a 2,048-output-token cap, a fresh
request session ID and `cacheRetention: "none"`. A 30-second outer deadline bounds waiting
even when a provider ignores abort; remote computation/billing cannot be guaranteed to
stop. Failed calls retain local summary claims. User-cue prose is saved but needs a
successful model attempt to become claims; it has no local extraction fallback.

Global recall is **not global rewriting**. Cross-origin variants remain separate instead
of guessing which project they describe. Exact-ID correction/forget works from any
session, affecting the target and exact duplicates within its origin, not identical text
from unrelated origins. Suppression hashes and same-origin conflict controls retain that
boundary. Some truly equivalent cross-origin corrections will consequently coexist;
explicit controls are available without becoming approval gates for automatic learning.

## Persistence and lifecycle

One SQLite database, WAL + FULL synchronous mode and private file permissions.
`sqlite.ts` selects built-in Bun or Node SQLite, with no external database dependency.

- `memories`: claims, revision/status/layer, source ID, capture origin (`scope`) and hash;
  optional `suppressedHashes` carries correction history through legacy annotation.
- `sources`: sanitized evidence and durable job state/lease/attempt.
- `blocked`: origin-qualified exact-content hashes for forgotten/superseded claims.
- `events`: actual before/after states, actor, operation timestamp and source/model reason.
- `metadata`: schema/import marker.

The `scope` field records canonical cwd, not an inferred repository/branch/subject identity
(or an explicit annotation of a legacy record). It is no longer a recall boundary. Reads
are cached globally or for an explicitly requested origin, invalidated by local commits
and SQLite `data_version` across connections. New IDs hash a JSON tuple of origin/kind/
content; existing IDs remain valid. Low-level origin filters are exact, including literal
`*` values; automatic recall uses the unfiltered reader.

Batches use `BEGIN IMMEDIATE`; no transaction spans network I/O. Source-origin generation
and job attempt are checked before completion can commit. A 60-second lease prevents
simultaneous execution of the same job. Startup considers pending/expired-running sources
across all origins; `/memory evolve` additionally considers failed attempts. Each selects
one newest eligible source, not the entire backlog, and never forces completed jobs to
run again. A source resumed in another directory retains its original provenance.

Capture is idempotent. Raw summaries are evidence only, never a parent recall fallback.
Exact forgotten content cannot be re-added within its origin under another source/kind.
Suppression also retires known repeating pending/failed sources, including formatted
claims beyond the normal 16-claim ingestion quota, except the current valid replacement
transaction's source. This conservatively skips the whole source's pending model pass;
unrelated local claims remain, but unlearned prose may need a new source.

Memory reads validate indexed identity/origin/hash against JSON. Undo validates paired,
unique before/after IDs and only succeeds when the current records still equal the event's
after state. New records become tombstones rather than being physically erased. Status
also validates source jobs/history. Unsupported schema versions are rejected before DDL.
These detect structural corruption, not all well-formed edits by an owner of the database.
Undo does not clear suppression hashes or reopen jobs. Forget/undo is not secure erasure.

## Existing data and commands

No migration, copying or marker reset is needed when upgrading the earlier directory-
filtered 0.2 build. Existing SQLite records, IDs, histories and origin labels stay intact;
they become eligible for global relevance-based recall, including existing `legacy` claims.

Original JSONL memory/action ledgers are imported once, without rewriting originals.
Invalid JSON/actions halt import rather than losing corrections or reviving forgotten
facts. Parent corrections preserve unchanged children and derive new facts without
reintroducing explicitly suppressed child content. Missing origins retain the `legacy`
label. Adoption is an optional annotation, not a recall prerequisite. Completed imports
are not replayed; earlier discarded revision information is not automatically reconstructed.
Old signals/proposals/execution plans remain historical files, never automatic actions.

List defaults to all origins, 20 per page sorted by update time then ID; `all` is an alias.
`here` and `legacy` are optional inspection filters, not recall settings. Search uses only
its explicit query and returns up to 10 global recallable matches. History shows the latest
10 global events. `show` includes provenance. Status identifies capture origin and global
recall mode. There is no full export command; concurrent writes can shift page boundaries.

## Validation and limits

Temporary-directory tests cover lifecycle sequences, real SQLite multi-process writes,
replay/migration/corruption/undo/timeout, global recall, topic switching, weak matches,
context tails, provenance and cross-origin write guards. The real-Pi RPC test uses a
loopback fake OpenAI-compatible model: two automatic updates in one directory, then a
fresh Pi process/session in another directory to verify recall, contextual follow-ups,
topic changes and exact-ID forget. It also verifies model/auth reuse and no approval.

Model inference and sanitization are not perfect. Provisional labels, pin/correct/undo
are recovery controls, not proof of truth. Lexical matching can miss semantic or cross-
language equivalence. Missing retained user context after compaction can leave a vague
follow-up unresolved. Cross-origin semantic identity is not inferred reliably. This is
one user's agent database, not a multi-user access-control boundary. Raw evidence/history
grows until deliberately managed; no automatic purge or physical secret erasure is claimed.
Background model usage is not added to Pi's normal session token accounting.

Node/npm development requires 22.19+ to match Pi 0.85's engine; the standalone Bun host is
also tested. There is no installed GitHub Actions workflow: `npm run check` and
`npm run test:pi` run locally. Fake-provider validation is not live-provider accuracy or a
multi-day TUI trial. See [README.md](../README.md) for commands/recovery, and the historical
[follow-up review](review-0.2.md) for previously reproduced defects and validation limits.
