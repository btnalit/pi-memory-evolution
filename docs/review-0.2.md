# Follow-up review of memory evolution 0.2

**Historical implementation review at `038de65`.** Its directory-scoped recall assumption
was subsequently identified as a requirements error: memory must follow the conversation,
not the working directory. Current behavior is documented in [design.md](design.md):
all-origin recall, recent-user topic context, visible provenance and conservative writes.
The test counts below describe that earlier review, not the current test suite.

Baseline: `9c84010` on `main`. Scope: all implementation modules, tests, the real-Pi
smoke script, package metadata and documentation. This review keeps automatic memory
updates, Pi's active model/authentication and the no-tools/no-approval boundary.

## Reproduced issues and fixes

The first nine isolated regression cases all failed against the baseline before fixes.
Additional tests were added while inspecting lifecycle sequences and host contracts.

| Area | Defect | Fix |
|---|---|---|
| Privacy | Removing controls after matching could assemble an unchecked `password` label. Multiline quoted/JSON values and indented YAML secrets leaked past line-only matching. | Normalize controls first; suppress quoted values and indented continuation blocks before capture, model submission and display. |
| Markdown extraction | Inner triple backticks could close a four-backtick fence. Bold stripping changed recursive globs, including globs inside code spans. Recognized nested headings caused later progress siblings to disappear. | Match fence character/length, protect code spans, only remove simple bold labels, and maintain a heading stack. |
| Identity and scope | Colon-concatenated scope/kind/content could collide for valid colon-containing paths. An undocumented `*` scope was included in every scoped read. | Hash a JSON tuple for new IDs and use exact scope lookup. Existing IDs remain valid. |
| Forget/retry | Forget retired only the first parent; other pending sources repeating the same fact could still feed a model and relearn a paraphrase. | Retire known repeating pending/failed sources, including formatted claims beyond the normal ingestion quota. Keep the current valid replacement transaction's source intact. |
| Legacy migration | Parent correction erased unchanged children; earlier child edits could prevent later corrected parents from deriving new facts. Corrected legacy claims lost old-content suppression when adopted. | Preserve unchanged children, distinguish newer parent corrections from obsolete child content, and carry suppression hashes through adoption. |
| Undo/integrity | A structurally corrupted before/after pair could write an unrelated record during undo. Indexed identity/hash and source job errors were incompletely checked; unsupported schemas could receive DDL before rejection. | Validate paired/unique IDs, record metadata and indexed values; validate sources/history in status; reject unsupported versions before DDL. |
| Batch deduplication | The same content with different kinds could be inserted twice within one local/model batch. | Deduplicate staged claims by exact content as well as persisted records. |
| Model provenance | Reading the live `ctx.model` again after awaiting completion could label an old response with the newly selected model or throw after context invalidation. | Capture the model and its identity before the call. |
| Async lifecycle/UI | A throwing context getter outside the queue's `try` could poison later work and shutdown. Notification failure could masquerade as rollback after a successful commit. Commands could reopen storage after shutdown. | Bound the entire queued task, isolate notifications from commits, retain truthful skipped/failed outcomes, and stop commands after shutdown. |
| Inspection commands | Only 20 unpaginated records were accessible; older legacy imports could not be reached for adoption. `show` omitted useful provenance. | Paginated current/all/legacy lists with stable ordering; `show` includes source and timestamps. Truncated previews are marked. |
| Excerpts | English sentences were not separated, and a long matching sentence could be clipped before its actual match. Tiny byte budgets could be exceeded by an ellipsis. | Sentence-aware and match-centered excerpts, code-point-safe clipping, and explicit tiny-budget handling. |
| Evidence dates | Pin/unpin, adoption and undo could make old project-state evidence appear fresh for another seven days. | Preserve or restore the prior evidence date; retain operation time separately in event history. |
| Smoke harness | Spawn failure and early process exit were not handled cleanly; cleanup could finish before the child exited. | Handle process/stdin errors, await close with bounded termination, and clean temporary state on failure. |

The wildcard case requires such a row to exist; there is no public command creating
one. The unsafe undo case requires corrupted/edited local history, not ordinary model
JSON. Neither is evidence that production data was attacked or overwritten.

## Validation

- **88/88 tests passed**, including a deterministic 150-step mixed lifecycle sequence.
- Strict TypeScript check passed.
- Node coverage: **100% lines, 90.28% branches, 98.25% functions**. Coverage alone is not
  a correctness guarantee; the baseline's high coverage did not catch these state-order bugs.
- Four real Node processes concurrently writing SQLite remain covered.
- Real Pi 0.85/Bun with a loopback fake OpenAI-compatible endpoint verified default-model
  and authentication reuse, two automatic updates, recall injection, removal of the digest
  after `/memory forget`, integrity checks and absence of approval dialogs.
- A nonexistent Pi executable fails without leaving new temporary state or a live server.
- Packaging is checked using `npm pack --dry-run`; tests and scripts are not runtime files.
- Synthetic performance sample: 600 summaries / 1,800 claims captured in about 1.05 s;
  reopening about 2 ms; cold/warm recall about 169/69 ms. These are local observations,
  not cross-machine benchmarks or a guaranteed performance budget.

All tests use temporary state and synthetic inputs. No paid model call, production-state
migration, cleanup or reset was performed as part of the validation.

Main regression files (links refer to a Git checkout; tests/scripts are not shipped in
an npm tarball):
Tests and maintenance scripts live in the Git checkout, not the runtime tarball:

- [State/privacy/parser regressions](https://github.com/btnalit/pi-memory-evolution/blob/main/src/memory/review-regressions.test.ts)
- [Pi lifecycle and command tests](https://github.com/btnalit/pi-memory-evolution/blob/main/src/index.test.ts)
- [Adapter tests](https://github.com/btnalit/pi-memory-evolution/blob/main/src/adapter/pi-api.test.ts)
- [Retriever tests](https://github.com/btnalit/pi-memory-evolution/blob/main/src/memory/retriever.test.ts)
- [Real-Pi smoke script](https://github.com/btnalit/pi-memory-evolution/blob/main/scripts/test-pi.mjs)

## Remaining boundaries

- Semantic model accuracy, arbitrary paraphrase equivalence and exhaustive secret
  detection are not guaranteed. Inferred claims remain provisional.
- Suppression conservatively skips an entire known repeating source's pending model
  pass. Unrelated local claims remain, but unlearned prose may need a new explicit source.
- Forget/undo is logical, not secure erasure. Previous files/history are preserved.
- Migration fixes apply to new imports; completed imports are not replayed and previously
  discarded revision information is not automatically reconstructed.
- Structural checks are not authentication of all well-formed local database edits.
- No live-provider quality evaluation, multi-day TUI trial or minimum-Node-version matrix
  was run. Local validation used Node 26.8.1 and the real Pi 0.85 standalone binary.
- History retention/export and periodic backlog draining remain outside this small design.

See [README.md](../README.md) for current commands and recovery procedures, and
[design.md](design.md) for runtime invariants.
