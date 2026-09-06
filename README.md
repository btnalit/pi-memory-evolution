# pi-memory-evolution

Automatic cross-session memory for Pi, recalled by topic from any working directory. **No owner approval, proposal queue, or manual execution plans.**

```text
compaction / explicit user correction
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
- No third-party runtime dependencies: SQLite is built into both runtimes.

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
  another compaction. Ordinary messages, assistant replies and tool results do not.
- Each processing attempt makes at most one background model call, using up to 32
  recently updated active memories from that source's capture origin. This is a
  conservative automatic-replacement safeguard, **not a recall restriction**.
  It uses **the current Pi session model and Pi's own provider/auth resolution**.
  With no model override in the session, this is Pi's configured default model.
  There is no extra API key, provider setting, subagent, or alternate-model fallback.
- Valid additions/replacements commit immediately, with provenance and before/after
  history. Inferred memories remain labeled `provisional`, but are recallable without
  approval. Pinned memories cannot be automatically replaced.
- Replayed source events are idempotent. Calls have a 30-second deadline and are
  cancelled on session shutdown/reload. Structured summary claims survive model failure.
  User-cue prose has no local-extraction fallback: its sanitized source is saved, but
  learning its claims requires a successful model attempt.
- Session start resumes at most **one**, most recently captured eligible pending source
  across all origins, even if this session starts in a different directory.
  `/memory evolve` similarly selects one source, also allowing failed attempts. Neither
  action drains the whole backlog. Jobs left running by a crash become eligible after
  their 60-second lease expires; there is no timer that automatically polls/retries them.
- Recall searches **the whole memory database**, including previous sessions, other
  directories and existing legacy claims. No project-directory startup or manual adoption
  is needed. Matching uses literal/identifier tokens and CJK bigrams locally, without an LLM.
- Vague follow-ups such as `继续` or `这个有问题` use the nearest identifiable topic from
  recent user messages in the active session branch. Explicit new topics do not inherit
  unrelated old topics. Assistant/tool/injected text is not used as the topic source.
  A fresh session saying only `继续` has no identifiable topic and injects nothing; naming
  the topic makes related memories available regardless of their original directory.
- Common words such as `没有` or `现在`, recency, pinning or cwd alone cannot trigger recall.
  At most three claims fit within **2048 UTF-8 bytes**, with origin/source labels and
  non-truncatable trust guidance. Fewer matches means fewer claims, not padding with recent
  records. Identical content from different origins retains separate provenance.
  Unpinned project-state claims age out after seven days; pinned claims do not.

A model call may incur the usual charges of your active provider. These background
calls are not assistant turns and their usage is not added to Pi's session token totals.
There is no additional call on ordinary recall. Model mistakes remain possible; use
history, correction, pinning and undo rather than treating generated claims as verified facts.

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
where available. Origin names help matching and current cwd only breaks relevance ties.

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
/memory status                       # database-wide integrity + capture origin/recall mode
/memory history                      # last 10 events across all origins
/memory evolve                       # retry one pending/failed source, any origin
/memory undo <event-id>               # reverse actual changes, if not modified since
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
Commands that take exact IDs can address records outside the current cwd. `search` uses
only its explicit query, whereas automatic recall can resolve follow-ups from recent
user context. Pin protects against automatic replacement/age expiry,
not manual edits, and does not force an unrelated record into every prompt. Pin/unpin
and adoption preserve the stored evidence date; undo restores the prior date. These
bookkeeping actions do not restart the seven-day project-state recall window.

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

**Upgrading from the earlier directory-scoped 0.2 development build:** existing SQLite
records, IDs, histories and origin labels remain unchanged. No copying, marker reset or
re-import is needed; they are immediately eligible for global relevance-based recall.
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
  gate. Forgotten/conflicted records and unpinned project state older than seven days
  are not recalled. Matching remains lexical, not a guarantee of semantic or cross-language
  equivalence; vague references can be missed.
- **Pending/failed jobs:** ensure Pi 0.85+ has a working current model/authentication,
  then `/memory evolve`. After a crash, wait for the 60-second lease to expire. Repeat
  the command to process more eligible sources; successful jobs cannot be forced to
  run again with this command.
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
`SQLite ok` checks database structure/record validity, not the truth of model claims.

## Development

```bash
npm ci --ignore-scripts
npm run check             # strict typecheck + regression tests + package inspection
npm run test:pi           # optional: real installed Pi, loopback fake model, no paid calls
```

Tests use temporary directories and synthetic data. `test:pi` accepts
`PI_TEST_BINARY=/path/to/pi`; it verifies real host loading, reuse of the active model
and authentication, automatic replacement, fresh cross-directory sessions, contextual
follow-ups, topic switches, provenance and forget, without approval dialogs. No GitHub
Actions workflow is currently configured; run these checks locally before pushing.
The real-Pi test uses a fake model, not a live-provider accuracy or multi-day TUI test.

See [docs/design.md](docs/design.md) for invariants and [CHANGELOG.md](CHANGELOG.md)
for the previous architecture and the 0.2 simplification. The follow-up
[code review](docs/review-0.2.md) records reproduced defects, fixes and validation limits.
