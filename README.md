# pi-memory-evolution

Automatic cross-session memory for Pi, recalled by topic from any working directory. **No owner approval, proposal queue, or manual execution plans.**

```text
compaction / explicit user correction / completed work observations
    → local extraction
    → automatic consolidation with Pi's active model
    → transactional memory update
    → topic-based recall across sessions and directories
```

Automatic changes are limited to this extension's memory database. The model gets
no tools and cannot edit project files, system configuration, skills or its own code.

## Requirements and installation

- Pi **0.85+** for semantic evolution via `ctx.modelRegistry.complete(ctx.model, ...)`.
- Pi's standalone Bun binary, or Node **22.19+** for npm Pi/development (Pi 0.85's minimum).
- No separately bundled runtime dependencies: Pi supplies TypeBox; SQLite is built into both runtimes.

`main` is the default development branch. Package version **0.2.0 is unreleased**:
there is no 0.2.0 release tag or npm publication yet. The old `v0.1.0` tag is historical.

Choose **one** installation source:

```bash
# Git installation: use the current default branch, without an old tag pin
pi install https://github.com/btnalit/pi-memory-evolution

# Or install a local checkout directly (no copy is made)
pi install /absolute/path/to/pi-memory-evolution
```

Then run `/reload` and `/memory status` in Pi. To update:

```bash
# For the Git installation above
pi update https://github.com/btnalit/pi-memory-evolution

# For a local checkout instead
cd /absolute/path/to/pi-memory-evolution
git switch main
git pull --ff-only origin main
```

Run `/reload` again after updating. A Git installation pinned to `v0.1.0` does not
follow `main`; install the unpinned Git source above to switch away from that pin.
When switching between Git and local sources, check `pi list` and use
`pi remove <old-source>` first: different source forms can otherwise load the extension
twice. Installation/removal does not erase memory state. Back up state before upgrading
from 0.1; see [Migration](#migration-from-01) and [Recovery](#recovery-and-troubleshooting).

## What happens automatically

- A successful `session_compact` saves a sanitized source and extracts up to 16
  facts, preferences, decisions or project-state claims using recognizable headings.
- Explicit user statements containing cues such as `remember`, `prefer`, `记住`,
  `偏好`, `纠正`, `不对`, `以后`, or `不要` also trigger learning, without waiting for
  another compaction. Assistant/tool text never becomes a user memory instruction.
- A completed, non-cue work turn (commit/push/fix/test/review, etc.) can update existing
  related project-state memories without waiting for compaction. It needs linked tool
  calls/results and a normal final assistant response. The extension saves bounded,
  sanitized observations, including failure flags, and nominates at most 8 existing
  unpinned project-state IDs from that capture origin, including states aged out of recall.
  Forgotten/conflicted states stay excluded. The model can only update those
  states, not create preferences or unrelated facts from tool output. Mere requests or
  assistant-only success claims do not trigger this path. Mixed explicit-cue/work turns
  retain the existing cue path, without a second progress call.
- Each processing attempt makes at most one background model call, using up to 32
  recently updated active memories from that source's capture origin. This is a
  conservative automatic-replacement safeguard, **not a recall restriction**.
  It uses **the current Pi session model and Pi's own provider/auth resolution**.
  With no model override in the session, this is Pi's configured default model.
  There is no extra API key, provider setting, subagent, or alternate-model fallback.
- Valid additions/replacements commit immediately, with provenance and before/after
  history. Inferred memories remain labeled `provisional`, but are recallable without
  approval. Pinned memories cannot be automatically replaced.
- Replayed source events are idempotent. Calls have a **120-second deadline** and an
  **8192-output-token cap** (clamped to the active model's smaller limit). They are
  cancelled on session shutdown/reload. Structured summary claims survive model failure.
  User-cue prose has no local-extraction fallback: its sanitized source is saved, but
  learning its claims requires a successful model attempt.
- Session start checks persisted work across **all origins**. While Pi remains running,
  a local recovery timer checks every **15 seconds** (after the previous check/call ends),
  gradually draining eligible pending/failed work one source per check. Selection favors
  the earliest retry time, then oldest capture; a failed source does not block other work.
- Failed attempts retry automatically after **1 minute, 5 minutes, 15 minutes, then 1 hour**.
  After **5 consecutive failures**, that source pauses and a warning points to diagnostics;
  there are no indefinite paid probes. Retry times/budgets survive reloads and restarts.
  `/memory status` shows safe error categories, failure times, attempt counts, next retry
  times and paused counts. `/memory evolve` remains an optional one-off override of the
  delay/limit, not the normal recovery path; successful/retired jobs are never rerun.
- A job lease lasts **150 seconds** (120-second deadline plus 30-second grace). The timer
  detects expired running jobs and schedules them with the same bounded backoff. Shutdown/
  reload cancellation returns work to pending without consuming the failure budget.
  Timers stop at shutdown and do not keep a print-mode process alive. Recovery resumes
  next time Pi runs; this is not a standalone daemon.
- Recall searches **the whole memory database**, including previous sessions, other
  directories and existing legacy claims. No project-directory startup or manual adoption
  is needed. Matching uses exact literals, word segmentation and weighted topic coverage
  locally, without a model call. Paths/filenames do not earn extra votes for their component
  words; for example, a repository named `pi-memory-evolution` is not itself evidence
  about cross-session memory.
- Natural questions such as `X相关记忆你还记得吗？` or `What do you remember about X?`
  separate the recall request from its actual subject. This applies across topics, not
  through per-device exceptions. Technical questions about memory/recall remain topics.
  Asking what Pi remembers does not itself trigger a paid learning call.
- Vague follow-ups use bounded recent **user** messages from the active branch, including
  retained compaction tails. Multi-hop refinements such as `SQLite 数据库 → 端口呢？ →
  认证呢？ → 继续` retain the subject and require the current attribute; prior-topic-only
  matches cannot satisfy the new question. Explicit new, unknown and reset topics stop
  old-topic inheritance. Assistant/tool/injected text never supplies the topic.
  A fresh session saying only `继续` injects nothing; naming a topic enables cross-session
  recall regardless of its original directory.
- Query coverage, evidence-based document frequency, field weights, mild length
  normalization and a relative cutoff reject weak secondary matches. Unseen query words
  no longer receive the highest rarity weight. Exact paths must match, and a quoted
  question in a replay/incident note is weaker than evidence answering it. Redundancy
  filtering cannot let a project-state note hide a preference of the same origin.
  Source IDs/cwd have no authority bonus. After relevance gates, host-assigned evidence,
  type-specific freshness and explicit feedback order eligible matches; pin/date break remaining ties.
  Common words such as `没有` or `现在` cannot trigger recall.
  At most three claims fit within **2048 UTF-8 bytes**, with origin/source labels and
  non-truncatable trust guidance. Fewer matches means fewer claims, not padding with recent
  records. Identical content from different origins retains separate provenance.
  Unpinned project-state claims still age out after seven days; pinning exempts age, not truth checks.
  Short named-attribute queries require the subject and attribute, rather than substituting
  another subject/attribute when the correct memory is missing or suppressed.
- Common Chinese/English concepts are normalized locally for existing records. Evolution
  can add up to 8 validated bilingual `searchTerms` per claim, extending matching without
  changing its factual text or adding a recall-time translation call. Aliases alone do
  not refresh evidence dates. This is bounded bilingual support, not universal translation.

A model call may incur the usual charges of your active provider. These background
calls are not assistant turns and their usage is not added to Pi's session token totals.
There is no additional call on ordinary recall. Eligible work turns may now incur one
additional background call each; no related tracked state or no tool observation means
no progress call. Automatic retries may add up to four calls per source after the initial
failure; every attempt uses the session's then-current model/authentication. Model mistakes
remain possible; tool observations and model-generated aliases are not proof of truth. Use
history, correction, pinning and undo rather than treating generated claims as verified facts.

## Evidence, decay and self-ranking

- New claims carry **host-assigned** evidence: `summary`, `user_statement`,
  `tool_observation` or `manual_correction`, plus extraction method, source ID and date.
  Model output cannot supply confidence/verification/feedback fields. Old records without
  this metadata remain `unknown`; migration does not guess their source or certify them.
- Source appropriateness matters: a user's stated preference is stronger evidence of that
  preference than a summary; a linked tool observation supports a project state, not a
  user preference or independent proof of success. A weaker model-proposed replacement
  is withheld and its new variant quarantined, with history. Current user corrections
  and new tool-backed project progress can still update automatically; pins remain protected.
- Freshness decreases smoothly by type: project state fastest, then facts, decisions,
  preferences. Stable kinds retain a nonzero floor and do not expire. Project states keep
  the seven-day safety cap; no upgrade revives old states. Read/search/injection, pinning,
  alias enrichment, feedback and conflict resolution do not reset the evidence clock.
- Ranking keeps **relevance, evidence, freshness and feedback separate**. Quality cannot
  rescue an unrelated/weak lexical match. `useful` is not `accurate`; neither is independent
  verification. Repeated retrieval or repeated positive feedback earns no cumulative boost.
  `/memory show` and `/memory explain` expose the factors. Injected claims include evidence
  labels and an aging warning, not a fictitious probability of truth.

Optional `/memory feedback <id> useful|unhelpful|accurate|incorrect` records a precise user
verdict without a model call. `unhelpful` modestly lowers utility, not factual credibility.
`incorrect` quarantines the claim and same-origin exact duplicates, retires known pending
repeats, and is undoable. Use `correct` for new content or `resolve` to restore a disputed
claim; conflict/resolution does not rejuvenate old evidence. Feedback with a timestamp
older than the current content's evidence date is ignored. Receipts prevent replay after restart/undo; identical repeated verdicts do not
accumulate weight. Feedback receipts, like history, are not securely erased by forget.
Whole user messages `记忆 <24-hex-id> 有用。` / `memory <24-hex-id> incorrect` also work;
quotes, questions, assistant/tool text and vague “wrong” do not identify a feedback target.
Ordinary natural-language corrections continue through automatic model evolution.

The model also gets a **read-only `memory_recall` tool** for missing background discovered
mid-task. It takes an explicit topic and returns up to three relevant claims / 2048 UTF-8
bytes, using the same lifecycle and quality gates. It does not modify memory, persist a
query in the memory DB, or make an additional retrieval-model call (normal agent tool
turns still incur normal usage and appear in the Pi transcript). Automatic per-user-turn
injection remains the default; the model chooses whether a second lookup is needed.
Explicit tool allowlists must include `memory_recall`; the extension never overrides them.

These are bounded evidence policies, not learned semantic verification, independent-source
corroboration, or a universally accurate self-evolving ranker. See
[core quality design and validation](docs/core-quality.md) for formulas and remaining gaps.

## Local storage and provenance

State lives under Pi's public agent directory (`getAgentDir()`). By default:

```text
~/.pi/agent/agent-suite/memory-evolution/
├── memory.sqlite       # memories, sources, suppression hashes, jobs and history
├── memory.sqlite-wal   # SQLite-managed when open
└── memory.sqlite-shm
```

If `PI_CODING_AGENT_DIR` is set, replace `~/.pi/agent` with that directory. Using a
different agent directory means a different database. Changing cwd does **not** hide
memories in that database or create a recall boundary.

SQLite transactions/WAL protect concurrent processes and interrupted commits.
Model calls run outside transactions; stale responses cannot overwrite intervening
changes. Raw summaries are evidence only, **never a separate recall fallback**, so
forgetting a derived claim cannot expose it again through its parent summary.

The stored `scope` field records capture origin (canonical cwd, not an inferred project
identity). It is retained for provenance and conservative write protection, not eligibility
for recall. An origin can cover multiple projects; facts must retain explicit subject names
where available. Explicit origin identifiers can help a named-context query at low weight;
current cwd, `legacy` labels and source IDs do not boost a claim's authority or relevance.

Global recall does **not** mean global rewriting: automatic replacement candidates remain
within the source origin, and the model must identify the same subject/fact, not just a
matching port or path. Cross-origin variants are not automatically merged or overwritten.
Exact-ID manual corrections/forget work from any session and affect the selected record
and exact duplicates within its origin, **not identical text from unrelated origins**.
Suppression hashes likewise remain origin-qualified. Arbitrary paraphrases or semantic
identity across origins cannot be resolved reliably by a local hash. These safeguards
may leave ambiguous variants for inspection rather than guessing which one to retire.
Forget is logical suppression, not secure erasure of history or the original Pi transcript.

Sensitive lines/blocks are suppressed before capture, edits, model submission and
recall. This covers common token/password/JSON/Chinese/Bearer/private-key formats,
including quoted multiline values, indented YAML blocks and control-character cleanup,
but not every possible secret. Do not rely on a regex as a complete DLP system. Sanitized
sources and selected existing memories go to the already-configured Pi model provider.

## Commands

These are optional direct controls, **not approval gates**:

```text
/memory list [page]                  # all origins, 20 non-forgotten records per page
/memory list all [page]              # alias for list
/memory list here [page]             # optional current-origin view
/memory list legacy [page]           # optional unknown-origin view
/memory show <id>                     # exact ID, any scope/status; includes provenance
/memory search <query>                # up to 10 recallable matches across all origins
/memory explain                       # last automatic recall snapshot, including injection count
/memory explain <query>               # preview retrieval reasons for an explicit query (3-claim cap)
/memory status                       # integrity + retry/paused diagnostics + recall mode
/memory history                      # last 10 events across all origins
/memory evolve                       # optional one-off retry, overriding delay/failure limit
/memory undo <event-id>               # reverse actual changes, if not modified since
/memory feedback <id> <verdict>       # useful | unhelpful | accurate | incorrect
/memory correct <id> <replacement>    # literal replacement, 4–480 characters
/memory forget <id>
/memory pin <id>
/memory unpin <id>
/memory conflict <id> <other-id>       # suppress both
/memory resolve <id>                  # restore this conflicted side; other stays suppressed
/memory adopt <id>                    # optionally label a legacy claim with this directory
```

Pages start at 1, sorted by update time descending, then ID. For example,
`/memory list legacy 2` reaches the next 20 imports. `all` is retained as an alias;
`here` and `legacy` are optional inspection filters, never recall settings. There is no
full export command. Concurrent updates can move records between
pages. Lists can show conflicted or stale project-state records that search/recall
excludes. Status counts include all scopes and tombstones and validate source jobs and
history as well as memory records. Long content previews are capped at 1,440 bytes in
lists/search or 8,000 bytes in `show`, with an ellipsis when truncated.
Commands that take exact IDs can address records outside the current cwd. `search` and
`explain <query>` use only their explicit query, whereas automatic recall can resolve
follow-ups from recent user context. `explain` without arguments shows the last automatic
snapshot: normalized focus/context features, eligible/excluded counts, scores, coverage,
up to 10 candidate IDs and rejection/selection reasons, plus actual injected count/bytes.
It retains at most 8,000 bytes (+ truncation marker) in memory, not a database/session log;
no memory bodies or provider errors are included. It resets on reload and is not proof
of what the model subsequently understood. Empty/no-match turns replace the old snapshot. Pin protects against automatic replacement/age expiry,
not manual edits, and does not force an unrelated record into every prompt. Pin/unpin
and adoption, feedback and conflict resolution preserve the stored evidence date; undo restores the prior date. These
bookkeeping actions do not restart the seven-day project-state recall window. Alias-only
model enrichment also preserves that date. A new, explicitly incorporated progress
observation can refresh it, even if the observed state is still unchanged/pending.
Manual correction clears old search aliases rather than attaching them to new content.

Undo reverses claim changes only when the affected records have not changed since;
it is not a database rollback. Suppression hashes remain, and jobs are not reopened.
Suppression retires pending sources known to repeat that fact, not just its first parent.
This skips the entire pending model pass for those sources; unrelated local claims remain,
but unlearned prose may need to be restated in a new source. Job state `done` also includes
these retired sources; history identifies actual model transactions.
There is no `/memory confirm`, `/evolution approve`, or owner-approval step in 0.2.

## Migration from 0.1

On first database use, valid `memories.jsonl` and `memory-actions.jsonl` are imported
once in a transaction. **Original files are not modified or deleted.** Corrupt or
unreadable ledgers stop migration rather than silently ignoring forget/correct actions.

Old records without origin metadata retain the label `legacy`. They participate in
relevance-based recall without adoption, with their unknown origin visible. Use
`/memory list legacy [page]` for inspection; `/memory adopt <id>` is an optional metadata
annotation, not a prerequisite for recall. Structured claims are extracted from eligible
legacy summaries, respecting existing lifecycle actions. Free-form raw summaries
remain available in the original JSONL but are not injected as claims. New imports
preserve unchanged children of corrected summaries and carry superseded-content hashes
when corrected legacy claims are adopted into a project.

**Upgrading from earlier 0.2 development builds:** stop Pi and back up the state directory
first, then update/reload all Pi processes sharing it. Schema markers **2, 3 and 4 upgrade
transactionally to 5**, adding replay-safe feedback receipts and the optional evidence/feedback
contract (plus missing retry fields for older schemas). Existing records, IDs, histories and
evidence dates remain unchanged. Missing evidence stays unknown, with no fabricated backfill.
Existing failures below the limit become automatically eligible; their old error cause/time
remain labeled unknown rather than invented. No copying, manual marker reset or JSONL
re-import is needed. Older builds reject schema 5; rollback requires a matching backup,
not editing the marker. Existing records are immediately eligible for global relevance-based recall.
Legacy claims previously excluded by cwd filtering become eligible too. This shares
relevant stored claims with the active Pi session/provider, not raw session archives.

These migration fixes do not replay an already completed import or retroactively erase
previously stored sensitive data. If an older import already lost revision information,
use the preserved ledgers/backup to review and correct affected records; do not reset the
migration marker or replace a populated database blindly.

Old signals, agenda, thresholds, proposals, journals and execution plans are historical
files only. This version neither processes nor deletes them. Back up the entire state
directory with Pi stopped before changing versions. Returning to 0.1 reads the old
JSONL, not changes made in the new database.

## Recovery and troubleshooting

- **No `/memory` command:** check `pi list`, then `/reload` (or restart Pi). Only one
  source of this extension should be installed. Processes marked by a nonempty
  `PI_SUBAGENT_AGENT_ID` deliberately do not load it.
- **No recalled memories:** check the active agent directory and `/memory search <topic>`.
  Name the topic if the current session has no recent user context; cwd is not a recall
  gate. `/memory explain` shows the last automatic decision; `explain <query>` previews
  an explicit query without invoking a model or updating claims. Forgotten/conflicted records and unpinned project state older than seven days
  are not recalled. Matching remains lexical, not a guarantee of semantic or cross-language
  equivalence; vague references and languages/terms outside the concept map or learned
  aliases can still be missed.
- **Old progress still shown:** age/weight does not prove a task finished. A new eligible
  work observation or compaction can update tracked progress; upgrading alone does not
  invent completion or replay old tool transcripts. Inspect `/memory show <id>` and
  history, or correct the record explicitly when you know the current state.
- **Pending/failed jobs:** normally no command is needed: leave Pi running and recovery
  automatically processes due work. `/memory status` distinguishes scheduled retries from
  paused sources and shows the next eligible time (the next poll may be up to 15 seconds
  later when no local work is queued). After a crash, the 150-second lease must expire first.
  If a source reaches 5 failures, inspect its category: `timeout`, `output_limit`,
  `invalid_output`, `write_rejected`, `stale`, `provider`, `unavailable`, `interrupted` or
  `unknown`. Fix model/authentication or investigate repeated output/write rejection;
  `/memory evolve` can then make one extra attempt without resetting the automatic budget.
  A bad source remains saved/visible rather than being deleted or labeled successful.
- **Persistent storage/import errors:** stop all Pi processes using that agent directory
  and back up the **entire** state directory, including any SQLite sidecars and legacy
  ledgers. Check file permissions and restore a known-good matching backup if needed.
  Do not delete `memory-actions.jsonl` to bypass an import failure: that can discard
  forget/correct history. Failed imports can retry after repairing the original ledgers;
  successful imports are never replayed merely because the old JSONL changes.
- **Disable the extension:** `pi remove <installed-source>`, then `/reload`. Its local
  database remains on disk. Restore/replace state only with all processes using it
  stopped; do not mix one backup's database with another's WAL/SHM files.

Diagnostics intentionally do not echo provider error bodies, which may contain secrets.
`SQLite ok (schema 5)` checks database structure/record validity, not the truth of model claims.

## Development

```bash
npm ci --ignore-scripts
npm run check             # strict typecheck + regression tests + package inspection
npm run test:pi           # optional: real installed Pi, loopback fake model, no paid calls
```

Tests use temporary directories and synthetic data. `test:pi` accepts
`PI_TEST_BINARY=/path/to/pi`; it verifies real host loading, reuse of the active model
and authentication, automatic replacement, fresh cross-directory sessions, contextual
follow-ups, topic switches, bilingual aliases, provenance and forget, without approval
dialogs. It also executes a real Git commit in a temporary repository and an intentionally
failed push (no remote), verifying the progress observation/update path using a fake model. No GitHub
Actions workflow is currently configured; run these checks locally before pushing.
The real-Pi test also seeds a persisted failure, injects malformed model output, and
verifies startup plus timer-driven recovery without `/memory evolve` or user activity.
Only the synthetic retry due time is accelerated; the real 15-second timer runs normally.
The real-Pi test uses a fake model, not a live-provider accuracy or multi-day TUI test.

See [docs/design.md](docs/design.md) for invariants and [CHANGELOG.md](CHANGELOG.md)
for the previous architecture and the 0.2 simplification. The follow-up
[code review](docs/review-0.2.md) records reproduced defects, fixes and validation limits.
The later [quality validation](docs/quality-validation.md) covers relevance, bilingual
recall and completed-work progress updates. [Conversation recall](docs/conversation-recall.md)
documents natural-question handling, multi-hop matching, diagnostics and validation limits.
