# Changelog

All notable changes to pi-memory-evolution are documented here.

## [0.3.0](https://github.com/btnalit/pi-memory-evolution/compare/v0.2.7...v0.3.0) (2026-09-10)


### Features

* let the host choose which records the model may replace ([#23](https://github.com/btnalit/pi-memory-evolution/issues/23)) ([5d4c868](https://github.com/btnalit/pi-memory-evolution/commit/5d4c868da2348e3ac1e205fc4166e2beaffbc2e1))


### Bug Fixes

* give the answer the model's own ceiling instead of one we invented ([#21](https://github.com/btnalit/pi-memory-evolution/issues/21)) ([3eba18a](https://github.com/btnalit/pi-memory-evolution/commit/3eba18a5f49136e5c9581c46b92f54cdee6ee6aa))

## [0.2.7](https://github.com/btnalit/pi-memory-evolution/compare/v0.2.6...v0.2.7) (2026-09-09)


### Bug Fixes

* unblock an unenforceable cost ceiling and remove the duplication behind three drift bugs ([#19](https://github.com/btnalit/pi-memory-evolution/issues/19)) ([875cd82](https://github.com/btnalit/pi-memory-evolution/commit/875cd821859d73b02ad9ba9cda2c21ff772b772f))

## [0.2.6](https://github.com/btnalit/pi-memory-evolution/compare/v0.2.5...v0.2.6) (2026-09-09)


### Bug Fixes

* reach an allowlisted sibling model and give claims real headroom ([#16](https://github.com/btnalit/pi-memory-evolution/issues/16)) ([ffc47d1](https://github.com/btnalit/pi-memory-evolution/commit/ffc47d148355d5cbf2d77bb5edd1d0111947b7e1))

## [0.2.5](https://github.com/btnalit/pi-memory-evolution/compare/v0.2.4...v0.2.5) (2026-09-09)


### Bug Fixes

* recover memory jobs with bounded cross-provider fallback ([#14](https://github.com/btnalit/pi-memory-evolution/issues/14)) ([76cfa6f](https://github.com/btnalit/pi-memory-evolution/commit/76cfa6fcd257866d6ed98a5b6a9fd14cc1b914a7))

## [0.2.4](https://github.com/btnalit/pi-memory-evolution/compare/v0.2.3...v0.2.4) (2026-09-09)


### Bug Fixes

* correct the schema marker in docs and state the promise up front ([#12](https://github.com/btnalit/pi-memory-evolution/issues/12)) ([2a651c4](https://github.com/btnalit/pi-memory-evolution/commit/2a651c484af606ab66b0381b8a73afc11a660585))

## [0.2.3](https://github.com/btnalit/pi-memory-evolution/compare/v0.2.2...v0.2.3) (2026-09-09)


### Bug Fixes

* select the model's final answer and diagnose output failures ([#10](https://github.com/btnalit/pi-memory-evolution/issues/10)) ([c7b3e7d](https://github.com/btnalit/pi-memory-evolution/commit/c7b3e7dbbd6d73324fcbf473d9cfa118da19ee30))

## [0.2.2](https://github.com/btnalit/pi-memory-evolution/compare/v0.2.1...v0.2.2) (2026-09-08)


### Bug Fixes

* support npm 12 pack output and gate CLI compatibility ([#7](https://github.com/btnalit/pi-memory-evolution/issues/7)) ([4fde298](https://github.com/btnalit/pi-memory-evolution/commit/4fde29844b6d2c9e9497a656f75d8655e812d4c6))


### Maintenance

* **deps-dev:** bump the development-minor-patch group across 1 directory with 3 updates ([#9](https://github.com/btnalit/pi-memory-evolution/issues/9)) ([03ef2be](https://github.com/btnalit/pi-memory-evolution/commit/03ef2beed637cfaa5c9dae22b26060c6f330d754))
* **deps-dev:** bump typescript from 5.9.3 to 7.0.2 ([#5](https://github.com/btnalit/pi-memory-evolution/issues/5)) ([dc97e2c](https://github.com/btnalit/pi-memory-evolution/commit/dc97e2c3306a0c1b07c34675d1eebaa7c73aaa8d))

## [0.2.1](https://github.com/btnalit/pi-memory-evolution/compare/v0.2.0...v0.2.1) (2026-09-08)


### Automation

* gate changes and automate verified npm releases ([#2](https://github.com/btnalit/pi-memory-evolution/issues/2)) ([87f9245](https://github.com/btnalit/pi-memory-evolution/commit/87f9245ef799870723ef1f6478eb623d2a37a958))

## [0.2.0] - 2026-09-08

### Changed

- Rewrite the README as a concise Chinese project introduction and installation guide; move detailed operation/migration behavior to `docs/usage.md`
- Declare public npm distribution alongside native Pi Git/local installation
- Replace print-only package inspection with runtime-source, peer-dependency and documentation-link assertions
- Separate operation/project-based progress nomination from answer retrieval; pending states naming a bare repository remain eligible without per-path top-2 or answer deduplication
- Preserve important commit/push/test observations ahead of late inspection; retain completed operations before error/aborted responses without claiming whole-task completion
- Expand bounded active-user context scanning to 4096 entries/messages and collapse repeated topic-less continuations while preserving reset/unknown-topic barriers
- Capture natural requirement/preference/priority declarations without requiring a remember keyword; mixed statement/work sources are serialized separately instead of discarding progress
- Exclude internal memory lookups/owned-state observations from progress evidence; include operation-resource hints and explicit observation omissions
- Evidence-aware self-ranking after lexical gates, with separate host-assigned source weights, type-specific gradual freshness decay and non-cumulative explicit feedback
- Schema 2/3/4 → 5 transactionally adds feedback receipts without rewriting old memories/history or inventing evidence
- Withhold weaker proposed replacements and quarantine new conflicting variants instead of overwriting stronger user/tool evidence; fresh tool progress can still supersede prior manually corrected states
- Short named-attribute queries cannot substitute another subject/attribute after the right answer is suppressed; query-only Chinese `多少` cleanup and numeric-value handling
- General conversational query planning: separate asking/remembering phrases from the subject, retain current focus across multi-hop user follow-ups, and stop inheritance on explicit/unknown/reset topics
- Evidence-based IDF for unseen terms, mandatory literal resource constraints, focused-context gates, bounded length normalization, and reduced weight for quoted questions rather than their answers
- Track redundant facets per origin and evidence kind so a project-state replay note cannot hide a preference/fact answering the same question
- Increase model deadline from 30 to 120 seconds and output cap from 2048 to 8192 tokens (bounded by model capability); allow up to 64 KB of validated result JSON without relaxing claim limits
- Replaced signal/maturity/speak/proposal/approval/plan machinery with direct automatic memory evolution
- Reuse Pi 0.85's active model and public `modelRegistry.complete`, including provider authentication
- Store claims, sources, jobs and actual before/after history in transactional SQLite (built-in Bun/Node APIs)
- One-time, read-only JSONL migration; unknown origins retain a visible `legacy` label, originals preserved
- Topic-based recall across sessions and directories, including existing legacy claims without adoption
- Capture origin is provenance and a conservative write safeguard, no longer a recall eligibility filter
- Raw summaries never provide a lifecycle-bypassing fallback
- Require Node 22.19+ for Node development/runtime, matching Pi 0.85's engine requirement; support the standalone Pi Bun binary

### Added

- Isolated real-Pi installation smoke tests for packed artifacts, Git install/update/old-pin transitions, and native npm install through a loopback registry; verify idempotent registration and memory/history preservation on removal
- `docs/testing.md` describing installation, fake-model integration and live-provider validation boundaries
- `/memory learning` capture/nomination diagnostics and persistent changed-record outcomes in status, distinguishing processed jobs from actual learning
- Long-task, interruption/cancel-recovery, operation-resource, natural-intent and mixed-authority regressions; real-Pi commit/failed-push followed by 12 diagnostics, plus read-only historical replay
- Host-assigned evidence basis/method/source/date, bounded evidence and aging labels in injection, separate quality factors in show/explain, lifecycle exclusion diagnostics
- `/memory feedback <id> useful|unhelpful|accurate|incorrect` and narrow exact-ID user feedback statements, without paid learning calls; replay/late-event protection, quarantine/undo, unchanged evidence clock
- Read-only `memory_recall` tool for a second explicit-topic lookup during a task, bounded to 3 claims / 2048 bytes with no query persistence in the memory database
- Core-quality regressions and real Pi tool/feedback/provider-payload round trips with a loopback fake model
- `/memory explain [query]`: bounded transient recall diagnostics, normalized focus/context, candidate rejection reasons and last automatic injection counts; no query/body history persisted
- Multi-domain Chinese/English natural-question regressions, learned-alias paraphrases, multi-hop attribute refinement, unknown-topic barriers, quoted-question distractors and real-Pi provider-payload validation
- Automatic startup and 15-second timer recovery across origins, with persisted 1m/5m/15m/1h backoff and a five-failure per-source cap plus pause warning
- Safe fixed-code failure diagnostics, attempt/failure counts, last failure and next retry times in `/memory status`; manual evolve remains an optional one-off override
- Transactional schema 2/3 → 4 migration preserving memory/history, automatically discovering old failures without inventing missing diagnostics
- Recovery regressions for durable scheduling, cancellations, concurrent leases, backlog draining, migration and real-Pi timer-driven retries with a loopback fake model
- Background consolidation after compaction or explicit user corrections, with bounded output/deadline and shutdown cancellation
- Source idempotency, job leases, stale-result guards, exact-content suppression, and indexed/cached reads
- Direct history/undo/search/status/evolve/adopt commands; no owner approval required
- Strict typechecking, reproducible development dependencies, real multi-process tests and an optional real-Pi loopback-model test (local commands, not an installed CI workflow)
- Current-branch installation/update, source deduplication, bounded retry behavior, command limits and storage recovery documentation
- Paginated current/all/legacy memory browsing and provenance in `/memory show`
- Follow-up regression cases and mixed lifecycle sequence testing
- Bounded active-user context for vague follow-ups, without assistant/tool/digest feedback
- Origin/source labels in injected claims; global list/search/history/retry and an optional `list here` view
- Real-Pi tests that restart in another directory to verify cross-session recall, topic changes and forget
- Word/concept retrieval with query coverage, document-frequency weighting, weak-result cutoffs and literal path handling
- Bounded bilingual `searchTerms`, validated/persisted/undoable without refreshing evidence dates
- Tool-backed completed-work observations that may only replace host-nominated existing project states
- Schema 2 → 3 marker upgrade preserving existing records/history; older builds require a matching backup for rollback
- Real-Pi bilingual/alias and temporary Git commit + failed-push tests, with no live model charges

### Fixed

- Natural recall questions failing or selecting the memory implementation because generic asking words diluted the actual topic
- Recall questions containing `remember` accidentally triggering a paid learning call; explicit learning instructions remain supported
- Unknown single-character subjects and Chinese question-particle cleanup accidentally becoming topic-less continuations or spurious query fragments
- Failed jobs remaining stuck until manual retry, and missing durable failure reasons/times
- Synchronize leases with longer deadlines (150 seconds by default); recover expired jobs with bounded backoff and release shutdown-cancelled work without consuming failure budgets
- False approval/verification, ineffective thresholds and dropped deferred proposals: obsolete workflow removed
- Cross-process lost updates and partial JSONL writes: transactional database replaces multi-file mutation
- Parent-summary recall bypass, correction/backfill invalidation and repeated startup scans
- CJK byte-budget overflow, truncated trust guidance, literal identifier corruption and timestamp string ordering
- Common credential leaks, pending-source replay after suppression, async error handling and provider timeout handling
- Control-character normalization and multiline quoted/YAML credential redaction
- Nested/mixed Markdown fences, recursive glob preservation and sibling progress headings
- Colon-ambiguous scoped IDs, implicit wildcard recall and same-batch cross-kind duplicates
- Pending repeats surviving forget, unchanged legacy children lost on correction, and suppression history lost on adoption
- Invalid before/after undo pairings, indexed identity/hash mismatches, malformed source jobs and DDL on unsupported schemas
- Model-switch provenance, poisoned background queues, UI errors misreporting committed changes and post-shutdown reopening
- English and long-sentence matching excerpts, unreachable legacy pages and smoke-test startup/cleanup failures
- Pin/unpin, adoption and undo making old project-state evidence appear fresh
- Cwd-restricted recall that contradicted the intended cross-session memory behavior
- Weak matches such as `有没有问题` selecting `没有 CI`, and context-free continuation pulling arbitrary recent claims
- Recall deduplication hiding distinct same-text facts from different origins
- Weak secondary results promoted by CJK fragments, path-component words and insufficient relevance coverage
- Current-cwd tie preference; source labels are not authority or verification weights
- Common Chinese/English memory-boundary questions missing the actual user preference
- Ordinary completed work not reaching evolution, leaving tracked project progress stale until compaction
- Corrections retaining search aliases from old content, and forgetting a target leaving queued progress observers eligible

## Legacy 0.1 history

The phase entries below are historical implementation notes, **not current behavior or
current safety guarantees**. Approval, shadow mode, thresholds, raw-summary recall and
execution plans described here were removed in 0.2. Legacy document paths refer to the
files as they existed then; see Git history or the `v0.1.0` tag for those versions.

## [P11] - 2026-09-03

### Added

- Bounded structural extraction from labeled compaction-summary sections
- Provisional `fact`, `preference`, `decision` and `project_state` records
- Idempotent startup hydration for summaries created before the extractor
- Regression coverage for section boundaries, deduplication, limits and sensitive bullets

### Safety

- Extraction is deterministic and offline; it never infers facts from unlabeled prose
- Extracted records remain provisional until explicitly confirmed by the owner

## [P10] - 2026-09-03

### Added

- Local `recent` / `durable` / `pinned` memory layers
- Deterministic lexical + layer-authority retrieval fused with Reciprocal Rank Fusion
- Append-only `memory-actions.jsonl` lifecycle projection
- Explicit `/memory` commands for list, confirm, correct, forget, pin, conflict and resolve
- Fail-closed exclusion of forgotten, conflicted and expired memories

### Changed

- Compaction summaries enter the recent/provisional layer by default

## [P9] - 2026-09-03

### Added

- Durable `memories.jsonl` storage for successful Pi compaction summaries
- Prompt-relevant cross-session retrieval using Latin-word and CJK-bigram matching
- Continuation-prompt fallback to the most recent durable context
- Runtime digest injection of selected durable memories
- Basic redaction of common API keys, tokens, passwords and secrets before persistence
- Deduplication by source compaction entry id and malformed-record tolerance

### Changed

- `session_compact` now persists the actual `compactionEntry.summary` while continuing to enable signal collection
- `before_agent_start` now uses the raw user prompt to select relevant durable memories
The format is based on [Keep a Changelog](https://keepachangelog.com/), grouped by phase.

## [P8] - 2026-08-13

### Added

- Evidence contribution derived as `weight × relevance` (replaces hardcoded 0) and read into maturity scoring
- Configurable speak-gate thresholds (`thresholds.json`): speakThreshold / priorityQueueThreshold / dailyDigestThreshold / suggestionLimit / strategicLimit, defaulting to Hermes values
- Real-environment drill evidence: current pi session verified to emit agent_end signals and maturation runs in real time
- Real pi compact fix: rpc sessions now compact successfully via multi-message accumulation (10+ alternating turns), firing a real session_compact event
- Compact-drill configuration reverted: the temporary `compaction.keepRecentTokens=2000` setting (drill aid) was removed — multi-message accumulation is the actual fix (25K-token sessions compact under the default 20000 budget)

### Changed

- `evaluateCandidate` accepts optional thresholds (defaults unchanged)
- Evidence strength now sums the contribution field

### Fixed

- Contribution field was a hardcoded 0 in evidence records (P2 gap)
- Feedback collection (P1 gap): real pi `turn_end.message` carries the assistant reply, not the user input, so correction keywords were never extracted in production; feedback is now collected from user-role messages in the `agent_end` batch (verified in a real rpc session)

## [P7] - 2026-08-13

### Added

- Approval identity recording: `approvedBy`/`approvedAt` now carry the deciding role (`assistant`/`user`) or `expiry` for auto-rejected proposals
- Verified signal word-boundary matching: `unverified`/`未验证通过`/`not verified` no longer trigger a verified transition
- Negated verification guard (`未验证通过`/`未验证完成`/`未通过验证`/`not verified`/`not verification passed`/`never verified`)
- Shadow calibration observation guide in `docs/design.md`

### Changed

- `transitionProposal` accepts an optional approval identity payload (approved/rejected only)
- Auto-approval journal lines now include the deciding role

### Fixed

- `unverified P-xxx` previously advanced implemented proposals to verified (substring match on `verified`); now stays implemented

## [P6] - 2026-08-13

### Added

- Word-boundary approval matching: `approved`/`token`/`okay` no longer trigger approval decisions
- Negated approval guard (`不执行`/`不批准`/`不同意`/`不可以` now reject instead of approve)
- Evidence carry: matured candidates and execution plans now include real collected evidence records
- Execution plan archive: terminal proposals move plans to `executions/archive/`, purged after 90 days
- Verified signal trigger: implemented proposals advance to verified via agent message with a verification keyword

### Fixed

- Residual false-approval vector: tool results can no longer trigger approval decisions (role whitelist)

## [P5] - 2026-08-13

### Added

- Proposal lifecycle state machine (pending_user_approval → approved/rejected → implemented → verified, with failed/rollback_required paths)
- Auto-approval channel: proposals surface in the runtime digest; the agent approves/rejects by referencing the proposal id; 24h expiry auto-rejects
- Record-first evolution executor: approved proposals produce markdown execution plans in `executions/`

### Changed

- Proposal approval moved from `ui.confirm()` to the auto-approval channel

## [P4] - 2026-08-13

### Added

- Speak gate consuming matured candidates: priority/speak scoring, risk dampeners, daily quotas, traceable decisions
- Proposal queue: approved candidates written as proposals

## [P3] - 2026-08-13

### Added

- Runtime digest injection into every session (`before_agent_start`), <2KB, expiry-stamped, advisory-only

## [P2] - 2026-08-07

### Added

- Memory evaluation using the Hermes maturation formula (evidence-driven, "time is not evidence")
- Agenda engine: state machine, unmatched-signal clustering, maturation pipeline
- Shadow mode: evaluation writes candidates and journal only, never triggers user-visible actions

## [P1] - 2026-08-05

### Added

- Signal collection: session stats, projection notices, user feedback → `signals.jsonl`
- Evolution journal (`evolution_journal.md`)
- Compaction-gated collection trigger and subagent-process skip

## [P0] - 2026-08-04

### Added

- Extension skeleton with capability probing and version-decoupling adapter layer
- `before_agent_start` lifecycle hook placeholder
- node:test suites
