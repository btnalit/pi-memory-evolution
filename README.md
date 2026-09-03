# pi-memory-evolution

Memory self-evolution system for the PI Coding Agent.

## Status

- **P0** (done): extension manifest, capability-aware adapter layer, `before_agent_start` lifecycle hook
- **P1** (done): signal collection (session stats, projection notices, user feedback) + evolution journal, with compaction-gated trigger and subagent skip
- **P2** (done): memory evaluation (Hermes maturation formula) + agenda engine (state machine, unmatched-signal clustering), running in shadow mode
- **P3** (done): runtime digest injection into every session (`before_agent_start`), <2KB, expiry-stamped, advisory-only
- **P4** (done): speak gate consuming matured candidates — scoring, quotas, traceable decisions, proposal queue
- **P5** (done): proposal lifecycle — auto-approval via agent messages (with 24h expiry), evolution executor writing record-first execution plans
- **P6** (done): hardening — word-boundary approval matching, evidence carried into execution plans, archived terminal plans, verified signal trigger
- **P7** (done): approval identity recording, verified keyword boundaries, shadow calibration guide, changelog
- **P8** (done): evidence contribution fill, configurable speak-gate thresholds, real-environment drill evidence
- **P9** (done): durable compaction-summary memory with prompt-relevant cross-session retrieval and basic credential redaction

## Features

- Collects signals from pi session events (agent-end statistics, projection notices, user corrections) into an append-only `signals.jsonl`
- Writes an audit trail to `evolution_journal.md`
- Signal collection starts after the first `session_compact` and runs on each `agent_end` / `turn_end`
- Evaluates memory maturity after 3 collected sessions using the Hermes maturation formula (evidence-driven, "time is not evidence")
- Tracks long-term agenda items through a state machine (`observing → accumulating_evidence → candidate_ready → surfaced → resolved → archived`)
- Discovers new agenda items from recurring unmatched signal clusters
- Runs in shadow mode: evaluation writes candidates and journal only, never triggers user-visible actions
- Evaluates matured candidates through the speak gate (priority/speak scoring, risk dampeners, daily quotas)
- Writes proposals as `pending_user_approval` and surfaces them in the runtime digest; the agent approves or rejects them by referencing the proposal id in a message (24h expiry, then auto-rejected)
- Executes approved proposals by writing a record-first execution plan (change / rollback / verification / evidence) to `executions/`; real behavior changes stay manual
- Persists successful compaction summaries as durable memories and retrieves relevant memories for later prompts
- Injects a runtime digest into every session (`before_agent_start`), carrying relevant durable memories, pending candidates, recent speak decisions and pending proposals
- Skips collection inside subagent processes (`PI_SUBAGENT_AGENT_ID` env)
- Zero core patches; everything runs as a pi extension

## Installation

```bash
pi install ./pi-memory-evolution
```

State files are written to `~/.pi/agent/agent-suite/memory-evolution/`:

```
memory-evolution/
├── signals.jsonl              # append-only signal records
├── memories.jsonl             # durable compaction summaries for cross-session continuity
├── memory-actions.jsonl       # explicit owner lifecycle actions (append-only)
├── self_agenda.yaml           # agenda items with maturity scores
├── agenda_candidates.yaml     # matured candidates (with evidence records)
├── speak_decisions.jsonl      # traceable speak-gate decisions
├── speak_quota.json           # daily speak quota usage
├── thresholds.json            # configurable speak-gate thresholds (optional)
├── proposal_queue.yaml        # proposals in lifecycle states
├── executions/                # record-first execution plans (one md per implemented proposal)
│   └── archive/               # plans of terminal proposals (auto-purged after 90 days)
└── evolution_journal.md       # audit trail
```

## Signal format

`signals.jsonl` is JSONL; each line is one record:

```json
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"session_stats","source":"agent_end","messageCount":3,"userCount":1,"assistantCount":1,"toolResultCount":1,"toolCallCount":1}
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"projection","source":"agent_end","count":2}
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"feedback","source":"agent_end","keywords":["不对"]}
```

Record types: `session_stats` (message/role/tool-call counts), `projection` (omitted or summarized tool results), `feedback` (user correction keywords). Feedback keywords are extracted from user-role messages in the `agent_end` batch — pi's `turn_end` message is the assistant reply, so collection happens at agent end (P8 fix).

## Maturity scoring

Agenda items are scored with the Hermes maturation formula:

```
maturity_score = 0.30×evidence_strength + 0.25×trend_strength + 0.20×recurrence_density
              + 0.15×unresolved_cost + 0.10×actionability
              + min(0.12, log(days+1)×0.03) − staleness_penalty
```

Signal-to-evidence mapping (fixed weights): `feedback` 0.30, `projection` 0.15, `session_stats` 0.05.

## Speak gate

Matured candidates are scored before user interruption:

```
priority = (impact×0.40 + recurrence×0.25 + confidence×0.35) × risk_dampener + bonuses
speak = priority − 0.20(interruption) − repeat_penalty
```

Decision routing: `speak_now` / `speak_now_with_approval` / `proposal_queue` / `daily_digest` / `silent_log_only` / `risk_alert_only`. Daily quota: 3 suggestions, 1 strategic. Every decision is logged with a traceable `decision_reason` and `would_have_spoken_without_quota`.

## Cross-session durable memory

After a successful `session_compact`, the extension stores the compaction summary in `memories.jsonl`. On each later prompt, it uses lightweight lexical matching (Latin words and CJK bigrams) to select up to three relevant summaries; continuation prompts such as `继续上次工作` fall back to recent summaries. Selected memory is included in the advisory runtime digest and the digest remains capped at 2KB. Duplicate compaction events are ignored by entry id, malformed records are skipped, and common credential formats are redacted before persistence. Explicit lifecycle actions are kept in `memory-actions.jsonl` and projected at read time, so memories can be confirmed, corrected, forgotten, pinned, or marked as conflicting without rewriting the base ledger or silently choosing between conflicts.

The owner can inspect and manage records with the built-in command:

```text
/memory list
/memory confirm <id>
/memory correct <id> <replacement text>
/memory forget <id>
/memory pin <id>
/memory conflict <id> <other-id>
/memory resolve <id>
```

This remains deliberately local and deterministic: it preserves compaction summaries and explicit owner edits, but does not use vector models or external retrieval services, and does not yet extract facts automatically from prose.

## Runtime digest

The session-injected digest (<2KB, advisory-only, `Valid until` 24h) carries relevant durable memories, pending candidates, recent speak decisions and proposals awaiting approval. Sections are omitted when empty; nothing hardcoded.

## Proposal lifecycle

Approved candidates become proposals in `proposal_queue.yaml` with the status `pending_user_approval` and a 24h `expiresAt`:

```
pending_user_approval → approved | rejected   (agent references the proposal id with an approval/rejection keyword)
pending_user_approval → rejected               (expired without a decision)
approved → implemented                          (executor writes an execution plan)
approved → rejected                             (manual)
implemented → verified | failed | rollback_required   (verified via agent message with a verification keyword)
failed → rollback_required
```

Approval flow:

1. The digest lists pending proposals as `Proposals Awaiting Approval` with their id and expiry.
2. The agent approves or rejects one by mentioning its id together with a keyword (e.g. `批准 P-20260805-0001` or `拒绝 P-20260805-0001`) in a session message. English keywords are word-boundary matched (`approved`/`token`/`okay` do not trigger); negated forms (`不执行`/`不批准`) reject instead of approve.
3. Unexpired proposals without a decision stay pending; expired ones are auto-rejected.
4. Approved proposals are executed by writing a markdown execution plan to `executions/P-<id>.md` (change, rollback, verification, evidence, manual checklist). The plan's evidence section cites the real collected evidence records. Execution is record-first: the plan is the deliverable, and real behavior changes are applied by the user outside the extension.
5. Once the user has executed the plan, the agent verifies the proposal by mentioning its id with a verification keyword (e.g. `已验证 P-20260805-0001`) — it advances to `verified`.
6. Plans of terminal proposals (verified/rejected/rollback_required) are moved to `executions/archive/` and auto-purged after 90 days. Implemented plans stay active for manual execution.

## Design

See [docs/design.md](docs/design.md), including the [shadow calibration observation guide](docs/design.md) (section 4.10).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for phase-by-phase change history.

## Development

Tests use Node's built-in test runner (node:test):

```bash
npm test
```

Because the extension imports `getAgentDir` from `@earendil-works/pi-coding-agent` at runtime, the test environment needs that package resolvable. On this machine it is symlinked from the global pi install:

```bash
mkdir -p node_modules/@earendil-works
ln -s /usr/lib/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
```

`node_modules/` is git-ignored; the symlink is a local development setup only.

## License

MIT
