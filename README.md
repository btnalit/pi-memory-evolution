# pi-memory-evolution

Memory self-evolution system for the PI Coding Agent.

## Status

- **P0** (done): extension manifest, capability-aware adapter layer, `before_agent_start` lifecycle hook
- **P1** (done): signal collection (session stats, projection notices, user feedback) + evolution journal, with compaction-gated trigger and subagent skip
- **P2** (done): memory evaluation (Hermes maturation formula) + agenda engine (state machine, unmatched-signal clustering), running in shadow mode
- **P3** (done): runtime digest injection into every session (`before_agent_start`), <2KB, expiry-stamped, advisory-only
- **P4** (done): speak gate consuming matured candidates — scoring, quotas, traceable decisions, `ui.confirm()` user approval, proposal queue

## Features

- Collects signals from pi session events (agent-end statistics, projection notices, user corrections) into an append-only `signals.jsonl`
- Writes an audit trail to `evolution_journal.md`
- Signal collection starts after the first `session_compact` and runs on each `agent_end` / `turn_end`
- Evaluates memory maturity after 3 collected sessions using the Hermes maturation formula (evidence-driven, "time is not evidence")
- Tracks long-term agenda items through a state machine (`observing → accumulating_evidence → candidate_ready → surfaced → resolved → archived`)
- Discovers new agenda items from recurring unmatched signal clusters
- Runs in shadow mode: evaluation writes candidates and journal only, never triggers user-visible actions
- Evaluates matured candidates through the speak gate (priority/speak scoring, risk dampeners, daily quotas) and asks the user to approve via `ui.confirm()`
- Writes approved proposals to `proposal_queue.yaml` (lifecycle handling is a later phase)
- Injects a runtime digest into every session (`before_agent_start`), carrying pending candidates and recent speak decisions
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
├── self_agenda.yaml           # agenda items with maturity scores
├── agenda_candidates.yaml     # matured candidates
├── speak_decisions.jsonl      # traceable speak-gate decisions
├── speak_quota.json           # daily speak quota usage
├── proposal_queue.yaml        # user-approved proposals
└── evolution_journal.md       # audit trail
```

## Signal format

`signals.jsonl` is JSONL; each line is one record:

```json
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"session_stats","source":"agent_end","messageCount":3,"userCount":1,"assistantCount":1,"toolResultCount":1,"toolCallCount":1}
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"projection","source":"agent_end","count":2}
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"feedback","source":"turn_end","keywords":["不对"]}
```

Record types: `session_stats` (message/role/tool-call counts), `projection` (omitted or summarized tool results), `feedback` (user correction keywords).

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

## Runtime digest

The session-injected digest (<2KB, advisory-only, `Valid until` 24h) carries pending candidates and recent speak decisions. Sections are omitted when empty; nothing hardcoded.

## Design

See [docs/design.md](docs/design.md).

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
