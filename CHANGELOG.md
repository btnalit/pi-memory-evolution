# Changelog

All notable changes to pi-memory-evolution are documented here.

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
