# pi-memory-evolution

Automatic project memory for Pi. **No owner approval, proposal queue, or manual execution plans.**

```text
compaction / explicit user correction
    → local extraction
    → automatic consolidation with Pi's active model
    → transactional memory update
    → scoped recall on the next prompt
```

Automatic changes are limited to this extension's memory database. The model gets
no tools and cannot edit project files, system configuration, skills or its own code.

## Requirements and installation

- Pi **0.85+** for semantic evolution via `ctx.modelRegistry.complete(ctx.model, ...)`.
- Pi's standalone Bun binary, or Node **22.18+** for npm Pi/development.
- No third-party runtime dependencies: SQLite is built into both runtimes.

Install this checkout (0.2.0 has not been published/tagged by this change):

```bash
pi install /absolute/path/to/pi-memory-evolution
```

Then `/reload` and `/memory status`. Updating a checkout does not update an existing
Git installation pinned to `v0.1.0`; switch the installed source to use this code.

## What happens automatically

- A successful `session_compact` saves a sanitized source and extracts up to 16
  facts, preferences, decisions or project-state claims using recognizable headings.
- Explicit user statements containing cues such as `remember`, `prefer`, `记住`,
  `偏好`, `纠正`, `不对`, `以后`, or `不要` also trigger learning, without waiting for
  another compaction. Ordinary messages, assistant replies and tool results do not.
- One background model call per source consolidates up to 32 existing memories.
  It uses **the current Pi session model and Pi's own provider/auth resolution**.
  With no model override in the session, this is Pi's configured default model.
  There is no extra API key, provider setting, subagent, or alternate-model fallback.
- Valid additions/replacements commit immediately, with provenance and before/after
  history. Inferred memories remain labeled `provisional`, but are recallable without
  approval. Pinned memories cannot be automatically replaced.
- Replayed source events are idempotent. Calls have a 30-second deadline and abort on
  session shutdown/reload. Failed calls retain the local extraction; `/memory evolve`
  retries a failed/pending source. Pending work can resume on session start.
- Recall is local: literal/identifier tokens, CJK bigrams, recency and pinned tie-breaks.
  It injects at most three deduplicated claims within **2048 UTF-8 bytes**. Trust guidance
  cannot be truncated. Ordinary project-state claims age out of recall after seven
  days; pinned claims do not. A continuation prompt may fall back to recent claims.

A model call may incur the usual charges of your active provider. These background
calls are not assistant turns and their usage is not added to Pi's session token totals.
There is no additional call on ordinary recall. Model mistakes remain possible; use
history, correction, pinning and undo rather than treating generated claims as verified facts.

## Local storage and isolation

State lives under Pi's public agent directory:

```text
~/.pi/agent/agent-suite/memory-evolution/
├── memory.sqlite       # memories, sources, suppression hashes, jobs and history
├── memory.sqlite-wal   # SQLite-managed when open
└── memory.sqlite-shm
```

SQLite transactions/WAL protect concurrent processes and interrupted commits.
Model calls run outside transactions; stale responses cannot overwrite intervening
changes. Raw summaries are evidence only, **never a separate recall fallback**, so
forgetting a derived claim cannot expose it again through its parent summary.

Scope is the canonical current working directory, not an inferred repository root.
Different directories have separate memories. Exact forgotten/superseded content is
suppressed across later extraction in the same scope. Forget is logical suppression,
not secure erasure of history or Pi's original session transcript. Arbitrarily
paraphrased facts cannot be perfectly identified as equivalent by a local hash.

Sensitive lines/blocks are suppressed before capture, edits, model submission and
recall. This covers common token/password/JSON/Chinese/Bearer/private-key formats,
not every possible secret. Do not rely on a regex as a complete DLP system. Sanitized
sources and selected existing memories go to the already-configured Pi model provider.

## Commands

These are optional direct controls, **not approval gates**:

```text
/memory list                         # current directory, last 20 non-forgotten records
/memory list all                     # include other scopes and legacy imports
/memory show <id>
/memory search <query>
/memory status                       # SQLite integrity and pending/failed jobs
/memory history                      # last 10 events in this scope
/memory evolve                       # retry one pending/failed source
/memory undo <event-id>               # reverse actual changes, if not modified since
/memory correct <id> <replacement>    # literal replacement, 4–480 characters
/memory forget <id>
/memory pin <id>
/memory unpin <id>
/memory conflict <id> <other-id>       # suppress both
/memory resolve <id>                  # restore this conflicted side; other stays suppressed
/memory adopt <id>                    # assign an unscoped legacy claim to this directory
```

## Migration from 0.1

On first database use, valid `memories.jsonl` and `memory-actions.jsonl` are imported
once in a transaction. **Original files are not modified or deleted.** Corrupt or
unreadable ledgers stop migration rather than silently ignoring forget/correct actions.

Old records have no project identity, so imports are quarantined under `legacy`.
Use `/memory list all` and `/memory adopt <id>` to assign needed records; they are
not silently exposed to every project. Structured claims are extracted from eligible
legacy summaries, respecting existing lifecycle actions. Free-form raw summaries
remain available in the original JSONL but are not injected as claims.

Old signals, agenda, thresholds, proposals, journals and execution plans are historical
files only. This version neither processes nor deletes them. Back up the entire state
directory with Pi stopped before changing versions. Returning to 0.1 reads the old
JSONL, not changes made in the new database.

## Development

```bash
npm ci --ignore-scripts
npm run check             # strict typecheck + regression tests + package inspection
npm run test:pi           # optional: real installed Pi, loopback fake model, no paid calls
```

Tests use temporary directories and synthetic data. `test:pi` accepts
`PI_TEST_BINARY=/path/to/pi`; it verifies real host loading, reuse of the active model
and authentication, automatic replacement and absence of approval dialogs.

See [docs/design.md](docs/design.md) for invariants and [CHANGELOG.md](CHANGELOG.md)
for the previous architecture and the 0.2 simplification.
