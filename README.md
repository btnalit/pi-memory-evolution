# pi-memory-evolution

Memory self-evolution system for the PI Coding Agent.

## Status

- **P0** (done): extension manifest, capability-aware adapter layer, `before_agent_start` lifecycle hook
- **P1** (done): signal collection (session stats, projection notices, user feedback) + evolution journal, with compaction-gated trigger and subagent skip

## Features

- Collects signals from pi session events (agent-end statistics, projection notices, user corrections) into an append-only `signals.jsonl`
- Writes an audit trail to `evolution_journal.md`
- Signal collection starts after the first `session_compact` and runs on each `agent_end` / `turn_end`
- Skips collection inside subagent processes (`PI_SUBAGENT_AGENT_ID` env)
- Zero core patches; everything runs as a pi extension

## Installation

```bash
pi install ./pi-memory-evolution
```

State files are written to `~/.pi/agent/agent-suite/memory-evolution/`:

```
memory-evolution/
├── signals.jsonl          # append-only signal records
└── evolution_journal.md   # audit trail
```

## Signal format

`signals.jsonl` is JSONL; each line is one record:

```json
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"session_stats","source":"agent_end","messageCount":3,"userCount":1,"assistantCount":1,"toolResultCount":1,"toolCallCount":1}
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"projection","source":"agent_end","count":2}
{"version":1,"ts":"2026-08-04T00:00:00.000Z","type":"feedback","source":"turn_end","keywords":["不对"]}
```

Record types: `session_stats` (message/role/tool-call counts), `projection` (omitted tool results), `feedback` (user correction keywords).

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
