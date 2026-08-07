# pi-memory-evolution

Memory self-evolution system for the PI Coding Agent.

## Status

- **P0** (done): extension manifest, capability-aware adapter layer, `before_agent_start` lifecycle hook
- **P1** (done): signal collection (session stats, projection notices, user feedback) + evolution journal, with compaction-gated trigger and subagent skip
- **P2** (done): memory evaluation (Hermes maturation formula) + agenda engine (state machine, unmatched-signal clustering), running in shadow mode

## Features

- Collects signals from pi session events (agent-end statistics, projection notices, user corrections) into an append-only `signals.jsonl`
- Writes an audit trail to `evolution_journal.md`
- Signal collection starts after the first `session_compact` and runs on each `agent_end` / `turn_end`
- Evaluates memory maturity after 3 collected sessions using the Hermes maturation formula (evidence-driven, "time is not evidence")
- Tracks long-term agenda items through a state machine (`observing → accumulating_evidence → candidate_ready → surfaced → resolved → archived`)
- Discovers new agenda items from recurring unmatched signal clusters
- Runs in shadow mode: evaluation writes candidates and journal only, never triggers user-visible actions (speak gate is a later phase)
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
├── agenda_candidates.yaml     # matured candidates (shadow mode)
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
