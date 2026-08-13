# Changelog

All notable changes to pi-memory-evolution are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), grouped by phase.

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
