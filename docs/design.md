# Memory evolution v0.2

## Goal

Automatically improve memory with Pi's active model, then recall relevant claims across
sessions and directories. Directory placement must not determine which memories a
conversation can use. No approval workflow, secondary agent, external retrieval service
or automatic changes to project files, system configuration, skills or extension code.

## Runtime

1. `session_start`: open/migrate lazily, check persisted pending/failed work across all
   origins and start a bounded recovery timer (one source per check, every 15 seconds
   after the previous check/call ends).
2. `session_compact`: atomically capture a sanitized session-qualified source and bounded
   local claims; enqueue semantic consolidation.
3. `agent_end`: capture explicit cues and natural user requirements/preferences,
   distinguishing recall questions from new statements. For work with linked operation
   results, capture a bounded `progress` source, including operations completed before an
   interrupted final response. Mixed statements/work use separate serialized sources;
   assistant/tool text never becomes a user preference. Pure memory lookup/inspection
   without a recognized work operation cannot trigger progress learning.
4. `before_agent_start`: resolve the current topic, search the whole memory database and
   append a bounded, source-labeled digest to this turn's system prompt. No model call.
5. `session_shutdown`: stop polling, abort work, return cancelled jobs to pending without
   increasing their failure count, drain the serial task chain and close SQLite.

Factories do not write state or start background work. Processes with a nonempty
`PI_SUBAGENT_AGENT_ID` are skipped. Recovery polls only indexed persisted job state;
there is no full-ledger backfill or scanning of arbitrary historical Pi session files.
The timer is unreferenced so it cannot hold a print process open and is never started
from the factory. Session-scoped context getters resolve the current model/auth at each
attempt; no stale model snapshot or foreground turn cancellation controls recovery.

## Conversation-aware recall

`adapter/session-context.ts` uses the public `buildContextEntries()` facade, not session
files or `getEntries()` across branches. It examines at most 4096 trailing active entries
and at most 4096 messages in total (including retained tails), selecting at most 6 user
texts of 2,048 UTF-8 bytes each. Consecutive topic-less continuations share a slot; reset
and unknown-topic barriers remain. Retained user tails survive compaction. Assistant/tool/custom and
injected messages are excluded, as are raw compaction summaries. Context is transient:
it is never re-captured as a source. Missing/invalidated context leaves direct-query
recall available rather than poisoning the hook.

`memory/query.ts` separates conversational recall framing from the subject, without
rewriting literal paths/filenames or stored evidence. Its query-only discourse vocabulary
handles Chinese/English asking/remembering phrases; technical memory/recall questions
retain those concepts. Unknown single-character query subjects remain unmatched barriers,
not permission to inherit an old topic or generate CJK fragment matches.

The bounded user history is replayed oldest first. Topic-less follow-ups inherit the last
resolved subject/focus. Related or attribute-only follow-ups carry a **structured** plan:
current query plus supporting subject context. Thus `SQLite → port? → auth? → continue`
retains SQLite without treating old port matches as answers about authentication. The
context does not grow by concatenating every earlier facet. Explicit new subjects stand
alone, even when unknown to the database; reset phrases stop inheritance. A fresh session
saying only `continue` identifies no topic and injects nothing.

All stored claims, including `legacy` imports, are candidates. Retrieval is local:
`Intl.Segmenter` words, exact path/filename identifiers, and a small Chinese/English
concept map. Synonyms contribute one feature rather than duplicated votes. Model-derived
`searchTerms` extend the vocabulary; old records need no reprocessing for the bootstrap
concepts. Paths such as `/work/pi-memory-evolution` do not imply the topic `memory`.
Common/filler words and generic configuration words cannot qualify a record.

For eligible records, a seen query feature weighs `1 + log((N+1)/(df+1))`; an unseen
feature weighs **1**, not the maximum IDF. Literals multiply weight by 2. Strongest field
factors are **assertion body 1, aliases 0.8, quoted question mention 0.25, explicit origin
identifier 0.2**. Quoted questions (`“...?”`, `「...？」`, `"...?"`) cannot qualify alone:
a replay note repeating a user's question is not evidence of its answer. Other quoted
facts remain ordinary evidence. Concept words in origins are excluded. Source IDs, legacy
labels and cwd have no authority bonus.

Current-focus coverage must be >=45%; at least 3 focus features still require 2 matches.
A single match cannot qualify alongside unknown non-attribute words. All explicit literal
constraints must match, including qualified paths rather than only shared basenames.
Supporting context contributes at 0.35 weight and cannot replace current-focus evidence.
Named context subject features must match; a concept-only contextual subject needs 60%
weighted subject coverage. Generic attributes are not subject anchors. Evidence gets mild
length normalization `0.8 + 0.2 * min(1, 12 / max(1, bodyFeatureCount))`. This cannot bypass
the subject/coverage gates. Scores below 75% of the best eligible result are rejected.
After these relevance gates, scores are multiplied by separate evidence/freshness/feedback
factors; pin/date/ID break remaining ties. These are policy weights, not truth probabilities.
Short queries with one nonnumeric named subject and explicit attributes require both, with
generic status/progress excluded from the mandatory-attribute check. Explicit origin names
can still help a named-origin query; attributes require body/alias evidence. Facet redundancy is tracked per origin **and kind**,
so a project-state mention cannot suppress a factual/preference answer. Exact same-content
same-origin duplicates are still removed, and distinct origins remain separate.
There is **no arbitrary recency fallback** or minimum result count.

One evaluation provides selection and bounded diagnostics. `/memory explain` shows the
last automatic snapshot, including actual digest count/bytes; `/memory explain <query>`
previews an explicit query without user-history inheritance. Snapshots hold normalized
focus/context (up to 32 features each), lifecycle counts and up to 10 scored candidates
(up to 16 matched features each), with no memory bodies. Serialized diagnostics are
sanitized/capped at 8,000 bytes plus an ellipsis, held only in the extension instance,
replaced on every automatic attempt (including empty/error), and never persisted as
learning input. Selection is not a guarantee of model understanding.

These are precision-oriented heuristics, not semantic verification or universal
translation. Word segmentation can vary with the runtime's ICU version; uncommon
languages, short/ambiguous queries and unannotated old records may still be missed.

The digest contains at most 3 claims within 2,048 UTF-8 bytes, with historical-data trust
guidance reserved first and an explicit warning that selected matches are not the complete
inventory. Each JSON row includes ID, kind, status, origin, source ID,
stored update date, evidence basis/method, aging warning, optional explicit accuracy
assessment and a matching excerpt of up to 400 bytes. The source label uses the current
evidence source when known (including manual corrections), otherwise the original source ID. Oversized metadata labels
are clipped with an ellipsis/hash suffix. Origins are provenance hints, not evidence
that another project's fact applies here. Identical content is deduplicated only within
one origin: equal port/path text from different contexts can mean different facts.

Forgotten/conflicted claims never recall. Every unpinned kind becomes **dormant** past its own
horizon — 7 days for project state, 180 for facts, 365 for decisions, 730 for preferences — which
stops it being offered for injection without deleting it: it stays stored, stays recallable on
request, and stays a replacement candidate, so later evidence can revive or retire it with no
human step. No kind has automatic age deletion. All kinds have bounded gradual freshness decay,
with separate half-lives/floors and pin exemption. Decay and dormancy run from the last
confirmation rather than the last edit; `updatedAt`, the replacement authority gate, never moves
for a confirmation.
Pin/unpin, legacy annotation, explicit feedback and conflict resolution preserve the evidence
date, and undo restores the prior date. Event history separately records when an operation occurred.

See [core-quality.md](core-quality.md) for the evidence contract, exact ranking policy,
weaker-replacement guard, replay-safe feedback and read-only mid-task `memory_recall` tool.
Neither automatic injection nor tool lookup is counted as evidence/usefulness feedback.

## Completed-work observations

The old cue/compaction-only input loop could retain “not committed” even when a normal
work turn later committed/pushed: that turn was never an evolution source.
`progress-observation.ts` requires a work request, linked call/result IDs, and at least
one recognized work operation. It scans up to 4096 current-turn messages, retains at most
8 observations by operation importance, and preserves chronological order. Commit/push
and test/process results outrank late routine inspection. Each stored operation <=1024
bytes, output <=2048 bytes; serialized evidence including request/report, bounded resource
hints and omitted-count/completion flags stays <=28,000 bytes. Head/tail previews preserve
failure endings. Internal memory tools and observations referencing the owned state directory
are excluded. An error/aborted final response uses `completion=interrupted` and no assistant
report: observed operations are evidence, not proof the entire task finished.

`memory/progress-targets.ts` separately nominates at most 8 active, unpinned project
states using user topics and explicit operation resources. It does not use answer-recall
literal gates, per-path top-2, relative cutoffs or facet deduplication. Explicit cd/git -C
and real checkout roots from file operations can match qualified paths or explicit bare
project names; capture origin alone supplies no evidence. Pending states receive nomination
priority. Conflicting absolute paths of the same basename cannot qualify through a topic
fallback. States expired from ordinary recall may receive new evidence, without reviving
forgotten/conflicted records. Tool output cannot nominate targets. No tracked related state means no call. `progress` sources are not parsed as local
summary claims: the model must return `project_state` plus `replaces` naming an eligible
host-nominated ID. Store guards enforce these restrictions even for a malformed model
batch. No new preference/fact, unrelated target or cross-origin overwrite is allowed.
The prompt requires evidence for each outcome and warns that commit/test success is not
push success, assistant reports are not proof, and failures/unfinished clauses must
remain. Outputs stay **provisional**: this is not independent success verification.

One qualified work source may add one background call. A mixed statement/work turn can
add a separate user-source call, serialized with progress to retain their distinct authority.
There is no assistant-only/ordinary-chat polling or startup transcript replay. Interrupted
work that was durably captured can recover with the existing retry mechanism. Hard kills
before agent_end, unknown commands and sources outside the scan/selection budgets remain
limits; there is no new disk-backed per-tool work journal. `/memory learning` reports
capture/nomination decisions, while status/history expose processed-versus-changed outcomes.
See [progress-pipeline.md](progress-pipeline.md) for policy details and validation.
Existing stale records are not guessed complete on upgrade. New observations/compactions
can retire them; exact-ID correction remains available. An incorporated new observation
may refresh an unchanged pending state's evidence date. Alias-only enrichment cannot.

## Model boundary and conservative writes

`adapter/pi-api.ts` calls Pi 0.85's public
`ctx.modelRegistry.complete(ctx.model, context, options)`, preserving model/provider/auth
resolution. Model identity is captured before awaiting completion, so switching models
or invalidating a context cannot mislabel provenance. No credentials are copied to state.

Each input contains a sanitized source (at most 32,000 bytes) and up to 32 existing active claims
**from that source origin that the source actually mentions**, each capped at 2,400 bytes
(`MAX_CLAIM_BYTES`, i.e. `MAX_CLAIM_CHARS * 3`). A record qualifies when the source mentions at
least 0.4 of its vocabulary, or of the aliases stored to widen its recall — containment, not
Jaccard, because a source is orders of magnitude longer than a claim. A progress source instead
uses exactly the records nominated in `targets`.

This is a **filter, never a ranking**, and the qualifying records keep the original recency order.
The cap applies **after** the filter, not before: capping by recency first meant a scope holding more
than 32 records could never show an older one again, however squarely the source was about it, so it
could never be superseded — only accumulated alongside. Reach is still bounded by the 32 most recent
qualifying records, and ordering stays by update time, never by recency of confirmation.
Containment is highest for a record the source merely restates and lower for the one it
contradicts, because the changed value is exactly the term that is missing; ordering by it and
cutting to a small cap would drop the record that most needed superseding, and both versions
would stay active forever. IDF weighting is worse rather than better, for the same reason.

The set shown is the set that may be named: **a source cannot replace a record it never mentions**,
because it is never offered one. This deliberately
limits automatic replacement authority, **not recall eligibility**. One origin can cover
multiple projects. The prompt requires an explicitly identifiable same subject/fact and
preservation of project/resource qualifications; matching cwd alone is not identity.

Output is validated JSON (an outer Markdown fence is tolerated), at most 64,000 bytes
and 16 claims of 4–800 UTF-16 code units each. Fields are restricted to `kind`, `content`,
optional `replaces` and `searchTerms`. Aliases are at most 8 sanitized strings of 2–64
characters, with total JSON <=1024 bytes. Malformed claims/aliases reject the batch.
The prompt asks for concise Chinese/English aliases, never added facts. Existing text
can gain aliases without changing its provenance/evidence date; correction clears stale
aliases and undo restores the actual prior metadata. Unknown, cross-origin, pinned,
stale, duplicate-target and cyclic replacements are rejected transactionally. Only normal
`stop` completion is accepted, never truncated/tool/error output. Model paths are not
used for file operations, and model claims remain `provisional`, not awaiting approval. Host-assigned evidence types
cannot be supplied by model output. A weaker proposed replacement is withheld; only that
source's new variant is quarantined and recorded, never an unrelated existing stronger claim.
A fresh explicit user statement or linked project-state tool observation can still supersede
older evidence. Unsupported semantic contradictions without a model `replaces` link are
not detected globally.

Each attempt uses at most one model call, no tools, a fresh request session ID and
`cacheRetention: "none"`. The output ceiling sent is **the active model's own `maxTokens`**,
never a smaller number of the extension's: a ceiling is spent on reasoning before any answer
is written, so an invented one can leave a thinking model with no room to answer, returning
`length` with zero bytes. A model declaring no limit is sent none. Reported `reasoning`
usage is recorded, so a starved reply is distinguishable from a broken one. Spend stays
governed per call, per source and per day by the routing policy. Context reservation and the
spend estimate reserve **exactly the ceiling that will be sent**, so neither can admit a payload
that leaves no room for the reply the request permits, nor admit a call as cheaper than it may
bill. A model declaring no limit is reserved 12,800 tokens, this contract's worst legal reply.
A 120-second per-attempt deadline bounds waiting even when a provider ignores abort;
remote computation/billing cannot be guaranteed to stop. A backup has a fresh deadline,
clamped by the source's remaining 300-second cumulative allowance. Failed calls retain local summary claims. User-cue prose is saved but needs a
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

- `memories`: claims, optional search aliases, revision/status/layer, source ID, capture origin (`scope`) and hash;
  optional `suppressedHashes` carries correction history through legacy annotation;
  optional host-assigned `evidence` and last explicit utility/accuracy `feedback` describe
  provenance and user assessments, never model-generated confidence.
- `sources`: sanitized evidence and durable job state/lease/attempt, consecutive failure
  count, next retry timestamp, last failure timestamp and a fixed error category;
  `progress` evidence additionally carries a bounded, unique target-ID list.
- `blocked`: origin-qualified exact-content hashes for forgotten/superseded claims.
- `events`: actual before/after states, actor, operation timestamp and source/model reason.
- `feedback_receipts`: exact source-ID/memory-ID idempotency keys, verdict and numeric
  timestamp, including redundant/late feedback receipts; undo never reopens them.
- `metadata`: schema/import marker.
- `model_calls`: reserved attempts, selected model/provider, outcome, usage and estimated/reported cost.
- `route_health`: provider/model cooldowns, separate from source backoff.
- `recovery_notices`: bounded persistent notice deduplication keys.
Source-level call/model/time/correction counts survive receipt pruning; shared ceilings are
reserved transactionally. The active model is preferred; allowed backups come only from
other Pi-configured providers. [Recovery policy and privacy](recovery.md) define the bounds.

The `scope` field records canonical cwd, not an inferred repository/branch/subject identity
(or an explicit annotation of a legacy record). It is no longer a recall boundary. Reads
are cached globally or for an explicitly requested origin, invalidated by local commits
and SQLite `data_version` across connections. New IDs hash a JSON tuple of origin/kind/
content; existing IDs remain valid. Low-level origin filters are exact, including literal
`*` values; automatic recall uses the unfiltered reader.

Batches use `BEGIN IMMEDIATE`; no transaction spans network I/O. Source-origin generation
and job attempt are checked before completion can commit. A lease lasts the attempt
budget plus 30 seconds (150 seconds by default), preventing another process from stealing
work at the old 60-second boundary. The timer converts expired leases to an `interrupted`
failure with backoff; attempt/state checks prevent late results or failures from changing
a new owner's job. Model waiting and recurring recovery use the same serial task chain;
queued capture/manual work prevents the timer from piling up duplicate tasks.

Automatic selection/claim enforce source backoff and call/time/failure caps. Least-recently
checked ordering prevents temporarily unroutable sources starving other work. Provider/model
cooldowns never contaminate a source's retry_at. Generic runtime backoff is 1 minute,
5 minutes, 15 minutes, then 1 hour with up to 20% jitter; quota/auth/rate-limit errors can
immediately use an allowed other provider. Two recent transport failures pause a model.
Defaults allow 4 reserved calls / 2 models / 300 seconds per source, one format correction,
and 20 reservations/hour shared across providers and processes. A write refused on the store's own authority — pinned,
cross-origin, or a record already newer than the source — pauses immediately, because the same
evidence would be refused again. A model that breaks the output contract is not the same thing:
it is reported as `invalid_output` carrying the rule it broke, and is corrected and retried.
Three output failures or five generic failures also pause work.
Shutdown adds no failures, but an already reserved request may still cost money.
`/memory evolve` overrides source delay/caps for one attempt, never shared ceilings.
Completed/retired jobs are never forced to run again. A source resumed in another directory
retains its original provenance. While Pi is closed no polling occurs.

Only allowlisted error codes are persisted, never exception strings, provider error bodies,
model response text or credentials. Stage categories distinguish provider/unavailable,
output limit, invalid output, write rejection, stale output, timeout and interrupted work.
Status reports retrying/paused counts and up to five failed-job details with next due times;
normal structural validation is still separate from model/job health.

Capture is idempotent. Raw summaries are evidence only, never a parent recall fallback.
Exact forgotten content cannot be re-added within its origin under another source/kind.
Suppression also retires known repeating pending/failed sources, including formatted
claims beyond the normal 16-claim ingestion quota, except the current valid replacement
transaction's source. This conservatively skips the whole source's pending model pass;
unrelated local claims remain, but unlearned prose may need a new source.

Memory reads validate indexed identity/origin/hash against JSON. Undo validates paired,
unique before/after IDs and only succeeds when the current records still equal the event's
after state. New records become tombstones rather than being physically erased. Status
also validates source jobs/history and the schema marker. Unsupported schema versions
are rejected before DDL. Schemas 2–6 upgrade transactionally to 7 without rewriting
claims/history or resetting evidence timestamps. Missing retry/feedback tables and routing
accounting are added; known v6 model waits are separated from source backoff. Old evidence metadata stays absent/unknown.
Old failures below the cap are due immediately, with unknown cause/time explicitly labeled.
The source/alias/retry contract is validated on read.
These detect structural corruption, not all well-formed edits by an owner of the database.
Undo does not clear suppression hashes or reopen jobs. Forget/undo is not secure erasure.

## Existing data and commands

Earlier 0.2 SQLite records, IDs, histories and origin labels stay intact and become
eligible for global relevance-based recall, including existing `legacy` claims. The
schema-2-through-6-to-7 upgrade requires no data copying, JSONL re-import or manual reset.
Stop/back up before upgrading, reload all processes sharing the DB, and restore a matching
backup for rollback; older code must not be pointed at a manually downgraded marker.

Original JSONL memory/action ledgers are imported once, without rewriting originals.
Invalid JSON/actions halt import rather than losing corrections or reviving forgotten
facts. Parent corrections preserve unchanged children and derive new facts without
reintroducing explicitly suppressed child content. Missing origins retain the `legacy`
label. Adoption is an optional annotation, not a recall prerequisite. Completed imports
are not replayed; earlier discarded revision information is not automatically reconstructed.
Empty/missing ledgers do not consume the import opportunity. Only saved digests proving a
recognized empty v6 snapshot (without a migration event) can reopen old completed markers;
zero derived claims from a real consumed ledger are not sufficient.
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
topic changes, bilingual aliases and exact-ID forget. A real temporary Git repository
also exercises commit success + push failure through actual tool events and the
constrained progress-update path. It also verifies model/auth reuse, no approval, startup
recovery of persisted failures, and recovery after malformed model output via the real
15-second timer without user activity. Unit tests cover persisted backoff/caps, migration
from the actual schema-3 table shape, long leases, competing owners, cancellation, timeout,
late results, suppressed sources, backlog draining, and fixed-code diagnostics.
The [quality validation record](quality-validation.md) records the three-issue follow-up
and distinguishes synthetic/real-host checks from real-data read-only replay.

Model inference and sanitization are not perfect. Provisional labels, pin/correct/undo
are recovery controls, not proof of truth. Lexical matching can miss semantic or cross-
language equivalence. Missing retained user context after compaction can leave a vague
follow-up unresolved. Cross-origin semantic identity is not inferred reliably. This is
one user's agent database, not a multi-user access-control boundary. Raw evidence/history
grows until deliberately managed; no automatic purge or physical secret erasure is claimed.
Background model usage is not added to Pi's normal session token accounting.

Node/npm development requires 22.19+ to match Pi 0.85's engine; the standalone Bun host is
also tested. GitHub CI runs the regression/package checks and isolated install/host
scripts; [release automation](releasing.md) reuses those gates before publishing.
Fake-provider validation is not live-provider accuracy or a
multi-day TUI trial. See [README.md](../README.md) for commands/recovery, and the historical
[follow-up review](review-0.2.md) for previously reproduced defects and validation limits.
