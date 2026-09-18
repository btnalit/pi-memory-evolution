# Full review — 2026-09-17

Independent review of pi-memory-evolution at branch `fix/automatic-memory-recall`
(HEAD `d20d7dd`), assessed against 0.4.0 on `main` (`d5f4cc6`). Every file under `src/`,
`scripts/`, `docs/`, `README.md` and `README.cn.md` was read in full, and the five
unmerged commits were read as diffs and as commit messages.

Every finding below cites a file and line on the branch and was verified either by
reading the code path end to end or by running it. Where a probe was run, the section
"How verified" says what was executed and what it printed. Line numbers are branch
line numbers; a finding marked **pre-existing** sits in code the drill did not touch,
so the same lines exist on `main` at a nearby offset.

## Baseline

Run on Node v26.8.1 in this checkout, branch HEAD:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | 295 / 295 pass, 0 fail, 9.2 s |
| `npm run check:docs` | pass (12 files, 7 historical mentions allowed by name) |
| `npm run check:automation` | pass |
| `npm run check:package` | pass (45 files) — needs `npm_config_cache` pointed at a writable directory in this sandbox |
| `npm run test:pi` | pass (real Pi host from `node_modules/.bin/pi`, i.e. the Node runtime, loopback fake model) |
| `npm run test:install` | pass (packed tarball, Git and loopback-npm installs, mixed-source conflict recovery) |

Everything is green. Nothing below was found by a failing gate; all of it was found by
reading and by probing behaviour the tests do not reach.

## Executive summary

The codebase is careful in the places the documentation says it is careful: one
transactional SQLite store with lease/attempt/generation checks, typed failure codes
with no raw error text persisted, redaction at every boundary, a strict output-contract
parser, and shared call/route accounting that holds across processes. The release and
CI pipeline is unusually well locked down for a project this size.

The defects are almost all in the seams between those careful parts, and most of them
predate the drill:

- **No P0.** Nothing found corrupts stored data or leaks a secret past the redactor. The
  three P1s all have a manual or configuration workaround, which is why they are not P0.
- **Three P1s, all in 0.4.0, all reachable in ordinary use.** (1) A source that is
  processed after a newer source in the same scope is *shown* a candidate the store will
  then refuse on authority grounds; the model names it, the whole batch is discarded and
  the source is paused for good. (2) Any event in a scope — including a capture that
  changes no memory — invalidates every in-flight model result for that scope, wasting the
  paid call and one of the four per-source calls, so a busy scope pauses sources by
  attrition. (3) On the 182 catalog models that declare `maxTokens === contextWindow`
  (all of Mistral's first-party models, Moonshot's, xAI's, many gateway entries) the
  byte-as-token context arithmetic goes negative and every attempt fails locally as
  `context_limit` without a request ever being sent.
- **The drill fixed a real defect and introduced two precision regressions.** Commit 1's
  diagnosis is correct and reproduces against `main` (a task-shaped prompt recalled
  nothing at coverage 0.09–0.29). The retriever half was revised twice within the drill
  and its final form is sound. The learning half (`DIRECTIVE`) turns ordinary one-off
  sentences into paid learning calls (10 of 11 probes; 0 of 11 on `main`), and the
  retriever's "an alias names a topic" rule lets a record with a generic model-written
  alias be injected on an unrelated prompt while its alias-less twin is correctly held out.
- **Commit 4 is incomplete on its own terms.** The live-prompt budget is correctly
  separated from the history budget and the tests prove that. But the motivating case —
  "a pasted stack trace, diff or spec ahead of the ask" — still recalls nothing whenever
  the paste contains a path, because every literal in the prompt is a mandatory
  constraint on every record (0.4.0 behaviour). Stack traces and diffs always contain
  paths. The fixture avoided them. `docs/usage.md` now promises the case on line 189 and
  contradicts it on line 195.
- **Recall is O(records) on the turn's critical path**, re-tokenising every record on
  every prompt: 0.5 s per turn at 5,000 records, 1.8 s at 20,000, and roughly +1 s for a
  60 KB paste at 3,000 records now that such pastes reach feature extraction.

## Findings

Severity: P0 = data loss or secret exposure with no workaround; P1 = the feature stops
working or paid calls are wasted in ordinary use; P2 = wrong behaviour reachable by an
ordinary user, with a workaround or bounded blast radius; P3 = edge case, cost, or
maintainability.

### P0

None. See the summary for why the P1s stop short of this tier.

### P1

#### F1 — A source processed out of order is shown a candidate it is forbidden to name; naming it pauses the source and discards the batch

- **Where:** `src/memory/memory-store.ts:357-372` (`selectCandidates` filters only on
  `active` and containment), `:462-463` (the authority refusal), `src/memory/evolution.ts:50`
  (the payload sends `id, kind, content, layer, origin, searchTerms, evidence, feedback` —
  no `updatedAt`). **Pre-existing** in 0.4.0.
- **Trigger:** S1 is captured at T1 and delayed (any backoff: rate limit, timeout, a
  `stale` result from F2). S2, captured at T2 > T1, runs first and replaces record R, so
  R′ has `updatedAt = T2`. S1 then runs; `selectCandidates` selects R′ because S1 mentions
  it; the model, which cannot see `updatedAt`, names R′ in `replaces`.
- **Impact:** `finishEvolution` throws the bare `Error("Invalid replacement target")`
  (`:463`), which `evolve()` maps to `write_rejected`; `failEvolution` (`:548`) pauses
  the source permanently with `diagnostics={}` — no `reason` is recorded, so
  `/memory status` shows `write_rejected` and nothing else. Every other claim in the same
  reply, including valid additions, is discarded. `/memory evolve <id>` re-runs the same
  selection and the model will usually name the same record again. Pinned records are
  in the same position: they are shown (`layer: "pinned"` is in the payload) and
  refused; `annotate()` (`:444`) and `reinforce()` (`:263`) both skip pinned records, so
  showing them has no upside.
- **How verified:** probe script: seed R (2026-09-01), capture S1 (09-02) and S2 (09-03),
  finish S2 replacing R, begin S1. Output: `S1 shown candidates [{id: R′, updatedAt:
  2026-09-03}] source.createdAt 2026-09-02`; `finish threw: Invalid replacement target`;
  status `s1: write_rejected … paused … diagnostics={}`; `pending(undefined,'auto')` an
  hour later returns `undefined`; the valid preference in the same batch is not stored.
- **Fix:** in `selectCandidates`, drop records the store will refuse on authority grounds
  before they are shown: `m.layer !== "pinned" && Date.parse(m.updatedAt) <=
  Date.parse(source.createdAt)`. Keep the throw at `:463` as defence in depth
  (`scripts/check-doc-constants.mjs:133-165` requires it to remain). Leave them in
  `memories` so the `existing` lookup at `:478` still de-duplicates against them.
  `src/memory/evolution.test.ts:45` currently pins `replacePinned → write_rejected`; after
  the fix that case becomes `unknown_replaces` (`invalid_output`), which is the correct
  classification for "the model named an id it was not shown", and the fixture moves.
  Also record a `reason` for authority refusals so `/memory status` can say *why*.
- **Test gap:** `src/memory/memory-store.test.ts:107-111` asserts the refusal but not the
  consequence for the source; no test asserts that a shown candidate is always nameable.

#### F2 — Any event in a scope invalidates every in-flight model result for that scope, including a capture that changed nothing

- **Where:** `src/memory/memory-store.ts:250-252` (`generation()` is `MAX(rowid)` over
  *all* events in the scope), `:283` (`record()` always inserts an event, even with an
  empty `after`), `:330` (`capture()` always calls `record()`), `:417` (the stale check).
  **Pre-existing** in 0.4.0.
- **Trigger:** while S1's model call is in flight (up to 120 s), the user's next turn ends
  and `agent_end` captures a `user` source in the same scope. User sources have no local
  claims, so `after` is empty, but an event is written and the generation moves.
  Feedback, `/memory pin` and a model reply with no changes do the same.
- **Impact:** S1's reply is rejected as `stale`, the paid call is wasted, `failures`
  becomes 1 with a 60 s backoff, and — because `beginEvolution` (`:399-400`) reserved a
  call — `calls` becomes 1 of 4. `PAUSED_SQL` (`src/memory/recovery.ts:14`,
  `src/memory/memory-store.ts:20`) pauses at `calls >= 4`, so four stale results pause a
  source permanently. In a project with `project_state` records, most work turns capture
  a progress source, so the collision window is every model call.
- **How verified:** probe script: begin S1 (`generation 1`), capture a second user source
  in the same scope (`memories after: 0`), finish S1 → `Memory evolution: stale`; status
  shows `failures=1/5 … calls=1/4 … nextRetry=+60s`.
- **Fix:** make the generation count only events that changed a memory:
  `SELECT COALESCE(MAX(rowid),0) FROM events WHERE scope=? AND
  json_array_length(json_extract(data,'$.after')) > 0`, backed by a partial index
  `CREATE INDEX IF NOT EXISTS events_scope_changes ON events(scope) WHERE
  json_array_length(json_extract(data,'$.after')) > 0` so it stays O(log n). A stricter
  alternative is to snapshot `(id, revision)` of `run.memories` at claim time and compare
  at finish. Either way, `docs/recovery.md:43` ("Stale result … not counted as a
  provider-health failure") should also say it *is* counted against the source's call
  budget, or the budget charge should be reversed for `stale`.
- **Test gap:** `src/memory/memory-store.test.ts:101-105` covers stale after a real edit;
  nothing covers stale after a zero-change event.

#### F3 — Bytes-as-tokens context arithmetic starves every model whose catalog entry declares `maxTokens === contextWindow`

- **Where:** `src/memory/evolution.ts:53-58` (`available = contextWindow - answerReserve -
  promptBytes - 1200`, then `Buffer.byteLength(JSON.stringify(payload)) > available` throws
  `context_limit`), `:34` (`answerReserve = answerCeiling(maxTokens) ?? MAX_OUTPUT_TOKENS`),
  `src/memory/processing-state.ts:63` (`context_limit` cools the model for one hour).
  **Pre-existing** in 0.4.0.
- **Trigger:** select any model whose Pi catalog entry sets `maxTokens` equal to
  `contextWindow`. Counting Pi 0.85.1's `models.generated.js`: 182 of 1,354 entries do,
  including every first-party `mistral/*` model (27), `moonshotai/*` and `moonshotai-cn/*`
  (16), `xai/*` (2), `google/gemini-3.1-flash-lite-image`, and 54 `vercel-ai-gateway`
  entries. A further 79 leave under 32,000 "tokens" of room, so a full-size source (32,000
  bytes, `memory-store.ts:320`) cannot fit either.
- **Impact:** `available` is negative before any request is made. Every candidate is
  popped, `context_limit` is thrown, the model is cooled for an hour, one of the source's
  four calls is consumed, and the source is eligible again immediately — so it fails
  again after the cooldown, and is paused after four rounds. With
  `crossProviderFallback` (default `true`) another provider silently absorbs the work; a
  user whose only provider is Mistral learns nothing and sees `context_limit` failures
  for calls that were never sent.
- **How verified:** probe with `ctx.model = { provider: 'mistral', id: 'devstral-latest',
  contextWindow: 262144, maxTokens: 262144 }` and a counting `complete` stub: `evolve
  threw Memory evolution: context_limit | provider called 0 times`; status shows
  `calls=1/4`; `routeAvailable()` is `false`. Catalog counts from a script over `MODELS`
  in `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/models.generated.js`.
- **Fix:** put the guard inside `answerCeiling()` (`src/memory/limits.ts:69-71`) rather
  than at the call sites, because `scripts/check-doc-constants.mjs:114-123` forbids digits
  and `Math.min/max` in the `answerReserve` and `maxTokens` statements: give it
  `(modelMaxTokens, contextWindow)` and return `undefined` when `maxTokens >= contextWindow`
  — the catalog convention for "may use the whole window" is not a usable ceiling, so
  nothing is sent and `MAX_OUTPUT_TOKENS` is reserved, which keeps the documented
  "reserve exactly what is sent" invariant. Separately, the estimate should stop treating
  a byte as a token: ~4 bytes/token for ASCII and ~1 per CJK character is conservative
  without being 4× too conservative; that would also stop dropping candidates
  unnecessarily on the 79 "tight" models.
- **Test gap:** no test constructs a model with `maxTokens >= contextWindow`.

### P2

#### F4 — A session with no model pauses every captured source permanently, and the pause is never revisited when a model appears

- **Where:** `src/adapter/pi-api.ts:37` (`if (!model) throw new
  EvolutionError("unavailable")`), `src/memory/memory-store.ts:548` (`unavailable` is a
  pause code), `src/memory/evolution.ts:30` (a missing model is labelled the string
  `'unavailable'`, which is then passed as a real model to `beginEvolution` at `:35`).
  **Pre-existing** in 0.4.0.
- **Trigger:** `ctx.model` is undefined when the recovery timer or an `agent_end` capture
  runs (no default model configured yet, or an RPC client that has not selected one).
- **Impact:** the source is claimed, a `model_calls` row is reserved with
  `model = 'unavailable'` (counting against the shared 20/hour and the source's 4), the
  adapter throws, and the source is paused for good. Configuring a model later does not
  un-pause it; each source needs `/memory evolve <id>` by hand. `unavailable` is also the
  code for `legacy_import_failed` and for an old host without `registry.complete`, where a
  hard pause is right; the missing-model case is transient and should not share it.
- **How verified:** probe with `ctx = { model: undefined, modelRegistry: {} }` through
  `evolveRouted`: `evolve threw … unavailable`; status `u1: unavailable … calls=1/4 …
  paused`; `pending(undefined,'auto')` an hour later returns `undefined`.
- **Fix:** in `evolve()`, return `false` before `beginEvolution` when
  `selectedModel` is undefined (the source stays pending and the 15 s timer retries once a
  model exists), and never pass the literal `'unavailable'` as a model name. Keep the
  hard pause for the two genuine `unavailable` causes.

#### F5 — Every path or filename in the prompt is a mandatory constraint on every record, so a pasted stack trace or diff recalls nothing — the exact case commit 4 set out to fix

- **Where:** `src/memory/retriever.ts:68` (`literals` = every `literal:` feature in query
  and context), `:100` (`literals.some(word => !matches.includes(word)) ?
  'resource-mismatch'` is the first gate), `src/memory/search.ts:49` (the `LITERALS`
  pattern), `:65` (only trailing `.` and `:` are stripped). **Pre-existing** gate; the
  drill's commit `297e9c3` widened the prompt budget to 65,536 bytes without touching it.
- **Trigger:** any prompt containing a path: a five-line Node stack trace followed by
  "Please install the dependencies and fix this."
- **Impact:** every record is rejected as `resource-mismatch` before coverage or topic
  matching runs; the record commit 4 targets (`deps`, aliases `pnpm`, `npm`) is not
  recalled. The literal also carries the frame suffix — the query feature is
  `literal:/home/me/invoice-api/src/export.ts:3:1)` — so even a record that named the
  file would not match it. `docs/usage.md:189` now says such a prompt "is still
  recalled"; `docs/usage.md:195` says "Exact paths must match, including case". Both
  cannot be true, and the second is what the code does.
- **How verified:** probe: the bare ask selects `["deps"]`; the same ask after a 5-line
  stack trace selects `[]` with reason `resource-mismatch` and query literal
  `["literal:/home/me/invoice-api/src/export.ts:3:1)"]`; `"… for src/export.ts and fix
  this."` also selects `[]`. Against the drill's own fixture store with 40 KB of
  `memory-store.ts` or `docs/recovery.md` pasted ahead of the ask, all four candidates are
  `resource-mismatch`.
- **Fix:** the gate must stay for a *targeted* literal — `src/memory/conversation-recall.test.ts:126-131`
  (`/srv/wrong.json database port` must not return the `/srv/right.json` answer) and
  `src/memory/reliability-regressions.test.ts:77-79` (`/srv/Atlas` must not match
  `/srv/atlas`) are the feature, and a "drop unknown literals" relaxation breaks both. Scope
  the relaxation to pasted material instead: in `queryFeatures`, literals found on lines
  that look like stack frames, diff headers or fenced code (`/^\s*at\s/`, `/^[-+]{3}\s|^@@/`,
  inside ``` fences, or ending in `:\d+:\d+\)?`) keep their ×2 weight but are not added to
  the mandatory set. Independently, strip `:\d+:\d+` and a trailing `)` in `search.ts:65`.
- **Test gap:** the drill fixtures (`conversation-recall.test.ts:297-298`, `:326-339`) are
  repeated prose with no path; no test pastes a trace or diff.

#### F6 — `DIRECTIVE` turns ordinary one-off sentences into paid learning calls and probable false preferences

- **Where:** `src/memory/learning.ts:26` (the regex), `:34` (it overrides the
  recall-question gate), `:41-42` (it overrides the question gate), `:43` (it is an
  `explicit-cue`). **Drill-introduced** (`8127577`, tightened in `ab49caa`).
- **Trigger:** any sentence starting with `always`, `never`, `don't`, `do not`, `from now
  on`, `going forward` or `in (the) future`, not followed by a pronoun.
- **Impact:** each match captures the whole message as a `user` source and spends one
  model call (`src/index.ts:148-152`). On this branch 10 of 11 probes learn; on `main`
  0 of 11. Several are one-off instructions a weaker model will plausibly store as a
  standing preference — "Don't worry about the tests for now, just make it compile.",
  "Do not run the migration, I just want to see the plan." — and `user_statement`
  evidence outranks summaries and can replace confirmed records (`src/memory/quality.ts:54`).
  Others are questions that the question gate would have caught without the override:
  "Never seen this error before, what is it?", "Always the same stack trace when I run
  it. Why?", "In the future tense, how would you phrase this sentence?". The cost is a
  paid call per match plus the F2 collision window it opens.
- **How verified:** `learningIntent()` over 11 sentences on the branch and on
  `main`'s `learning.ts` (extracted with `git show main:…`): branch `learn:true` for all
  but "Never mind the linter…"; `main` `learn:false` for all 11.
- **Fix:** two cheap narrowings, then a negative fixture list: (1) `DIRECTIVE` must not
  override the question gate when the text ends in `?`/`？` — position does not make a
  question a rule; (2) treat "for now", "for this", "this time", "just", "yet" after the
  cue as one-off markers. `scripts/check-doc-constants.mjs:313-341` pins the regex's
  shape (single anchored group) and the cue list, so the change must keep that structure
  or update the walk.

#### F7 — A generic model-written alias counts as "naming the topic", so an unrelated record is injected while its alias-less twin is correctly rejected

- **Where:** `src/memory/retriever.ts:91` (`topicMatches++` when `aliases.has(word)`),
  `:122` (`incidental-overlap` waived when `topicMatches > 0`). **Drill-introduced**
  (`ab49caa`, kept by `b0a07db`).
- **Trigger:** a record whose `searchTerms` include an everyday word the prompt uses. The
  evolution prompt asks for aliases "grounded in that claim", so a compliant model writes
  `server` for a note about the server room.
- **Impact:** the subject-side safeguard is only as strong as the weakest alias. With
  aliases `['server','access']`, `badge` ("Badge access to the server room needs security
  approval") is **selected** on "The invoice API server needs a health endpoint before
  the tests can run in staging." on matches `server,needs`; the identical record without
  aliases is `incidental-overlap`. This is precisely the filler `README.md:21` promises
  not to inject, and the concept-side breadth the design doc accepts is not the cause
  here — concept-only matches are held out by `thin-match` (probed: four
  test/commit notes all `thin-match` on a task prompt mentioning tests and a commit).
- **How verified:** probe over a 7-record store; diagnostics printed
  `badge selected cov=0.313 matches=server,needs` and `badge2 incidental-overlap cov=0.313
  matches=server,needs`.
- **Fix:** an alias (or concept) names a topic only if it is rare in the store: reuse the
  `df` already computed at `:60-66` and require `df <= max(2, 0.02 * documents.length)`
  for the alias to count. That is data-driven and prompt-invariant, which is the property
  `b0a07db` established. `scripts/check-doc-constants.mjs:289-292` pins the exact
  `topicMatches++` statement and must be updated with the change.

#### F8 — Undoing a pin, unpin, adoption or alias-only event blocks the record's live content hash and retires unrelated pending sources

- **Where:** `src/memory/memory-store.ts:718` (`this.block(after)` for every `after`
  record, whatever changed), `:721` (`fingerprint(after.content)` is added to
  `suppressedHashes`, so `record()` at `:280-281` inserts it into `blocked`), `:287-303`
  (`block()` also marks every non-done source in the scope `done` if it contains the
  content). **Pre-existing** in 0.4.0.
- **Trigger:** `/memory pin <id>` then `/memory undo <event>`, while a `user` source that
  quotes that record's sentence and adds a second, unrelated requirement is pending.
- **Impact:** the pending source is marked `done` without a model pass — its unlearned
  prose is lost silently — and the still-active record's own content hash sits in
  `blocked` for its scope. `docs/usage.md:376-379` documents source retirement for
  *suppression*; undoing a pin is not suppression.
- **How verified:** probe: `pending before undo: pending-user`; after `undo(pin)`:
  `pending after undo of PIN: undefined`, the source row is `done`, `blocked` holds the
  record's hash while the record is `provisional/durable`.
- **Fix:** in `undo()`, call `block()` and add the hash only for records whose content is
  actually being removed — `event.before[i] === null` or
  `before[i].content !== after.content`. Metadata-only undos should not touch `blocked`.

#### F9 — Remembered text is injected into the system prompt, and the local-extraction path stores compaction bullets verbatim with no model gate

- **Where:** `src/index.ts:177` (`systemPrompt: `${event.systemPrompt}\n\n${digest}``),
  `src/injector/digest.ts:7` (the only mitigation is a header sentence),
  `src/memory/memory-store.ts:324` (summary sources are extracted locally at capture),
  `src/memory/extractor.ts:24-66` (any bullet under a recognised heading becomes a claim
  with no judgement beyond length and redaction). **Pre-existing** in 0.4.0.
- **Trigger:** content that reaches a compaction summary — tool output, a fetched page, a
  pasted document — and is summarised under a "Key decisions" / "Constraints &
  Preferences" heading becomes a `summary/local` claim. Later, any prompt on that topic
  (or the topic named in its aliases) injects it, in the system prompt, in every session
  that shares the store.
- **Impact:** a persistent, cross-session injection channel into the highest-trust
  position of the context. The output-contract parser fully contains what a *learning*
  call can do (four fields, nameable ids only, no tools), so the write side is sound; the
  read side relies on the model honouring one sentence of header. `docs/usage.md` and
  `docs/design.md:24` say this is by design ("historical data, not instructions").
- **How verified:** by reading; `BeforeAgentStartEventResult` in Pi 0.85.1
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:845-849`)
  allows returning either `systemPrompt` or a custom `message`.
- **Fix:** move the digest out of the system prompt into the `message` slot the hook
  already permits (a custom message is conversation-level trust, not system-level), keep
  the header, and delimit each excerpt so heading/instruction-looking text cannot be read
  as structure. If the system prompt must stay, at least strip leading `#`/`>`/`-` and
  collapse newlines in `excerpt()` so a remembered bullet cannot open a new section.

#### F10 — Recall is O(records) on the turn's critical path and re-tokenises every record on every prompt

- **Where:** `src/index.ts:173` (`readMemories()` of every scope, cloned, then
  `retrieveMemories`, synchronously in `before_agent_start`), `src/memory/retriever.ts:52-58`
  (three `features()` calls per record per query; the cache is local to one evaluation),
  `:60-66` (`weights` is O(query features × records)), `src/memory/memory-store.ts:376-411`
  (`beginEvolution` computes `selectCandidates` — `features()` over every active record in
  the scope — *inside* `BEGIN IMMEDIATE`). **Pre-existing**; commit `297e9c3` raises the
  query-feature term from ≤2 KB to ≤64 KB of prompt.
- **Trigger:** a store that has run for a while. The docs' own measurement was 154 records.
- **Impact (measured):** synthetic store, one scope, 16-word claims, Node 26:

  | records | `readMemories` cold / cached | recall per prompt | `beginEvolution` (write lock held) | `status()` |
  | --- | --- | --- | --- | --- |
  | 1,000 | 38 / 13 ms | 90–130 ms | 116 ms | 59 ms |
  | 5,000 | 154 / 59 ms | 470–530 ms | 537 ms | 191 ms |
  | 20,000 | 581 / 175 ms | 1.7–1.8 s | 2.3 s | 819 ms |

  Tokenisation is ~70 % of recall (`features()` ×5,000 = 348 ms; `redact()` ×5,000 = 36 ms).
  The project's own earlier samples agree with the slope: `docs/quality-validation.md:49-51`
  and `docs/review-0.2.md:50-52` record cold/warm recall of 196/99 ms and 169/69 ms at
  1,800 records, which is the same ~0.09 ms per record measured here.
  A 59 KB diverse paste (this repository's `memory-store.ts`) yields 1,167 query features
  and costs 928 ms against 3,000 records versus 246 ms for the bare ask. `beginEvolution`
  at 20,000 records holds the write lock for 2.3 s, approaching the 5 s `busy_timeout`
  (`src/memory/limits.ts:12`); a `capture()` in another process that times out throws,
  and because `agent_end.messages` is per-run (`pi-agent-core/dist/agent-loop.js:170`),
  that statement is never re-offered.
- **Fix:** (1) cache tokenised documents per `(id, revision, searchTerms)` in the extension
  instance, invalidated with the `readMemories` cache — this removes ~70 % of per-turn
  cost; (2) compute `weights` only for query features present in at least one document
  and cap the query at a few hundred features; (3) compute `selectCandidates` before the
  transaction and re-validate the id set inside it; (4) `nominateProgress` compiles a
  `RegExp` per record per resource (`src/memory/progress-targets.ts:13`) — hoist it.
- **Test gap:** no test constructs more than a few dozen records.

### P3

#### F11 — A `bearer ` (or `--password `) at the end of a line survives per-line redaction and then wipes the whole progress source

- **Where:** `src/memory/privacy.ts:6` (`\bbearer\s+\S`), `src/adapter/progress-observation.ts:16-21`
  (`preview()` redacts line by line), `:73` (`JSON.stringify(payload)` makes one line),
  `src/memory/memory-store.ts:320` (`capture()` redacts that one line). **Pre-existing.**
- **Trigger:** tool output `Authorization header must be bearer ` followed by a newline.
- **Impact:** per line, `\s+\S` has nothing to match and the line is kept; in the JSON
  string `bearer \nSee` the `\` of the escape satisfies `\S`, so the *entire* source becomes
  `[REDACTED sensitive line]`, and a paid call is made on it.
- **How verified:** probe printed the per-line result unchanged and `capture()`'s result
  as `"[REDACTED sensitive line]"`.
- **Fix:** redact structured progress content field by field before serialising (it already
  is, via `preview()`), and skip the second pass for `kind === 'progress'`; or anchor
  `\S` to `[^\s\\]`.

#### F12 — Secret patterns miss several common token shapes

- **Where:** `src/memory/privacy.ts:3-6`. **Pre-existing.**
- **Verified unredacted:** `AKIAIOSFODNN7EXAMPLE` (AWS), `xoxb-…` (Slack), `AIza…` (Google),
  `npm_…` (npm), `glpat-…` (GitLab), `eyJ….eyJ….sig` (JWT). `docs/usage.md:313-316` says
  "not every possible secret", which is honest; these six are cheap, low-false-positive
  prefixes worth adding to `SECRET`.

#### F13 — A feedback line naming an unknown or inactive memory aborts the rest of `agent_end` for that run

- **Where:** `src/index.ts:143-147` (`feedback()` is called inside the message loop with no
  local catch), `src/memory/memory-store.ts:634` (throws for an unknown id *before* the
  receipt check at `:635`), `:636` (throws for a forgotten/conflicted id). **Pre-existing.**
- **Impact:** the loop exits through `guard`, so later user messages in the same run are
  not captured and `inspectProgress` (`:154`) never runs — the turn's progress observation
  is lost. Bounded to one run because `messages` is per-run.
- **Fix:** catch around the feedback call and record the failure in `lastLearning`, or
  return `undefined` from `feedback()` for an unknown id.

#### F14 — A replacement whose content already exists outside the window is dropped silently, leaving the contradicted record active

- **Where:** `src/memory/memory-store.ts:476-479`: `claim()` returns `undefined` because
  the content hash already exists in the scope (`:310`), `existing` is searched only in
  `run.memories` (the recency window plus candidates), and `(!next && !existing)` →
  `continue`. **Pre-existing.** Verified by reading; the comment at `:350-356` documents
  the window as the write-through bound but not this consequence.
- **Trigger:** a scope with more than 32 active records; the model replaces R with text
  that equals an older record R2 outside the 32 most recent and not itself mentioned by
  the source (or equals a forgotten tombstone, `:479`).
- **Impact:** no error, no diagnostic; R stays active and contradicted, and the job is
  marked `done` with `changedRecords=0`.
- **Fix:** look `existing` up by `(scope, hash)` in the database rather than in
  `run.memories`, then apply the existing branch logic.

#### F15 — Literal extraction keeps frame suffixes and closing punctuation

- **Where:** `src/memory/search.ts:49` (`[^\s`"'<>，。！？,;!?]+` admits `)` and `:3:1`),
  `:65` (strips only trailing `.`/`:`). **Pre-existing.** Verified: query literal
  `literal:/home/me/invoice-api/src/export.ts:3:1)`. Part of the F5 fix.

#### F16 — The doc-constants gate now asserts source *shape*, which any refactor will trip

- **Where:** `scripts/check-doc-constants.mjs:256-293` (regexes over `retriever.ts` text,
  including an exact `topicMatches++` statement and a count of assignments), `:298-307`
  (forbids the literal `2048` in two files), `:313-341` (walks the `DIRECTIVE` regex's
  parentheses). **Drill-introduced** (`8127577`–`297e9c3`, +102 lines).
- **Trigger:** any edit to those statements — the F6 or F7 fix, or splitting the
  `DIRECTIVE` literal across two lines — followed by `npm run check`.
- **Impact:** these encode the drill's *implementation*, not its behaviour; renaming a
  variable, splitting a line or fixing F6/F7 fails `npm run check` with a message that
  argues for the old code. The behavioural tests added alongside (which go red when the
  changes are reverted — verified) already guard the same properties.
- **Fix:** keep the numeric and documentation checks; move the code-shape assertions into
  the tests they duplicate, or delete them.

#### F17 — Documentation drift

- **Trigger:** read the linked architecture pages from `README.md:126` as a description of
  the installed 0.4.0.
- `docs/design.md:1` is titled "Memory evolution v0.2"; `docs/core-quality.md:3`,
  `docs/progress-pipeline.md:3`, `docs/conversation-recall.md:3` and
  `docs/quality-validation.md:4` each describe "unreleased 0.2.0"; `docs/usage.md:380`
  says "in 0.2". The package is 0.4.0 and these files are linked from the README as
  current architecture. Mark them as dated records or update them.
- `docs/usage.md:189` vs `:195` — the pasted-log promise and the exact-path rule
  contradict each other (F5).
- `docs/design.md:406-407` says "the standalone Bun host is also tested"; CI resolves `pi`
  from `node_modules` (`scripts/test-pi.mjs:108`, `.github/workflows/ci.yml`), so the
  `bun:sqlite` branch at `src/memory/sqlite.ts:8` runs only when a developer sets
  `PI_TEST_BINARY` locally.
- `README.md:21` "no relevant match means no unrelated filler" is not true under F7.
- `docs/recovery.md:43` says a stale result is "not counted as a provider-health failure";
  it is counted against the source's call and failure budgets (F2).
- Historical test counts (`docs/core-quality.md:229` 194, `docs/conversation-recall.md:53`
  164, `docs/quality-validation.md:35` 122) are fine as dated records but read as current.

#### F18 — One invalid memory row disables all recall with no repair path

- **Where:** `src/memory/memory-store.ts:235` throws "Invalid memory record; recall
  stopped" from `readMemories()`, which `before_agent_start` (`src/index.ts:173`) and
  `memory_recall` (`:200`) call unfiltered. **Pre-existing**, and fail-closed by design.
- **Trigger:** one row whose JSON fails `isMemory()` or whose stored hash disagrees with
  its content — a hand edit, a partial write from a crashed pre-WAL build, or a future
  validator tightening — anywhere in the database, in any scope.
- **Impact:** every automatic injection and every `memory_recall` call fails with one
  warning per hour; but there is no command that names the bad row or quarantines it. Suggest a
  `/memory status` line naming the id and a `/memory forget <id>` path that accepts it.

#### F19 — Origin paths are sent to the provider and injected into the prompt

- **Where:** `src/memory/evolution.ts:50` (`origin: scope`), `src/injector/digest.ts:18`
  (`origin: label(memory.scope)`). The absolute working directory (which often contains a
  client or project name) leaves the machine with every learning call and enters the
  model context on every injection. `redact()` does not treat paths as sensitive.
  **Pre-existing**, documented as provenance.
- **Trigger:** work in a directory named after a client or an unreleased product; any
  learning call or injection from that origin.
- **Fix:** an opt-out that sends and injects the basename only, keeping the full path in
  the local record.

#### F20 — Capture failures are not retried

- **Where:** `src/index.ts:150` inside `guard`; `agent_end.messages` is this run's messages
  only. **Pre-existing.**
- **Trigger:** `capture()` throws once — a transient `SQLITE_BUSY` from another process
  holding the write lock past the 5 s `busy_timeout` (see F10), a full disk, or the F4/F18
  store errors — on a turn that carried a learning cue or a work observation.
- **Impact:** the statement or observation is lost; the notice says "local records
  retained", which is true of *other* records only.
- **Fix:** queue failed captures in memory and retry them on the next `agent_end` or
  timer tick.

### Reviewed and found sound

The task asked for eight areas. Two of them produced no finding and are recorded here
so the absence is a result, not a gap.

**Path and file handling.** The state directory is created `0o700` and the database file
`wx` + `0o600`, re-checked with `lstat` for regular-file and non-symlink before opening
(`src/memory/memory-store.ts:95-101`); SQLite inherits that mode for `-wal`/`-shm`.
Legacy ledgers are opened `O_RDONLY | O_NOFOLLOW`, `fstat`-checked as regular files and
capped at 16 MB (`src/memory/legacy.ts:19-27`); the archive path uses `mkdtemp` and `wx`
writes, and removes its own directory on failure (`src/memory/legacy-files.ts:13-26`).
`recovery.json` is size-capped at 8 KB before parsing, prototype keys are rejected by the
own-property check, and a rejected file names itself without echoing contents
(`src/memory/routing-policy.ts:23-31`). Paths from model tool arguments are only
`resolve`/`realpath`/`existsSync`-inspected, never executed, and values with shell
metacharacters are dropped (`src/adapter/operations.ts:54-57`); the state-directory
self-reference regex is escaped (`:94`). `/memory import <dir>` reads only. No traversal,
symlink-follow or unbounded read was found.

**Concurrency.** Every write goes through `BEGIN IMMEDIATE` (`memory-store.ts:221-225`)
under a 5 s `busy_timeout` shared by every opener (`sqlite.ts:11-15`); reads are cached
per instance and invalidated by `PRAGMA data_version`, so cross-process writes are seen
(`:226-242`). A claim is lease + attempt; a commit requires `state='running'`, the same
attempt and the same generation (`:403-417`); an expired lease is converted to
`interrupted` with backoff, and a late result or late failure from the old owner is
rejected by the attempt check (`:537-539`). The serial `work` chain and the `queued`
counter keep the 15 s timer from stacking tasks (`src/index.ts:75-123`). Shared call
windows, route cooldowns and cost reservations are rows in the same database
(`processing-state.ts`), so four processes contend for one slot correctly
(`routing-concurrency.test.ts`). One suspected race — a concurrent confirmation writing
`reinforcedAt` under a write-through built from an older snapshot — was probed with two
store instances on one file and is **not reproducible**: `reinforce()` is reached only
through `finishEvolution`, which always records an event, so the competing write is
rejected as `stale`. F2 and F10 are the concurrency findings; both are about the
*granularity* of a check that exists, not a missing one.

## Verdicts on the five drill commits

Method: each commit was read as a diff; its tests were run with the change reverted
(topic gate disabled, live budget restored to 2,048, `DIRECTIVE` removed) to confirm
they go red; the retrieval fixture was run against `main`'s `retriever.ts`.

| Commit | Verdict | Evidence |
| --- | --- | --- |
| `8127577` fix: recall from how a task is actually described | **Correct diagnosis, incomplete implementation, and regressive on the learning side** | The diagnosis reproduces against `main`: the drill's fixture prompts recall `["deps"]` on the branch and `[]` on `main` with reasons `low-coverage` at coverage 0.287 and 0.088. The subject-coverage floor it introduced (`MIN_SUBJECT_COVERAGE = 0.25`) was wrong in the way `b0a07db` later describes and no longer exists — so this commit's retriever change is a stepping stone, not a fix. Its `DIRECTIVE` cue is the source of F6 (10/11 one-off probes learn; 0/11 on `main`). Its `session()` harness in `src/index.test.ts:470-513` is a genuinely new coverage class (two store instances over one directory). |
| `ab49caa` fix: require a named topic on the subject side; anchor every English directive cue | **Correct, with one residual** | Anchoring every `DIRECTIVE` alternative and refusing a following pronoun is right and the negative fixtures prove it. The `incidental-overlap` gate fixes the reproduced badge/onboarding false positives; six tests go red when it is disabled. The residual is F7: "one of the model-written aliases" is treated as a topic name regardless of how generic the alias is. |
| `b0a07db` fix: carry a record on the subject side by naming its topic, not by a share of its own wording | **Correct** | Removing the record-side share is the right call; the argument that any share of the record makes recall depend on claim length is sound, and the regression test (`the same engagement carries a claim whatever its length or alias count`) goes red without the change. F7 is inherited unchanged. |
| `297e9c3` fix: give the live prompt its own query budget | **Incomplete** | The split into `MAX_HISTORY_TURN_BYTES` / `MAX_QUERY_BYTES` is correct, the self-inclusion comparison against `currentAsHistory` (`src/memory/query.ts:76-83`) is the right fix for the dedup bug it would otherwise create, and both tests go red when the budget is restored. But the commit's stated motivation — "a pasted stack trace, diff or spec ahead of the actual ask" — still recalls nothing whenever the paste contains a path (F5); the fixture is repeated prose with no literal in it; and the change makes `docs/usage.md:189` contradict `:195`. It also puts up to 64 KB of pasted material through `features()` and the O(features × records) weight loop on the turn's critical path (F10: +0.7 s at 3,000 records). |
| `d20d7dd` test: lock in CJK incidental-overlap safeguard | **Correct** (test-only) | Goes red when the topic gate is disabled (`multilingual incidental overlap cannot displace a named subject`). It duplicates the English test's shape, which is fine for a bilingual product. |

Net: the branch is an improvement over 0.4.0 for its target case (task-shaped prompts)
and should be merged once F6 and F7 are addressed, because both are precision
regressions the user's weak-model validation channel will surface. F5 is the real
remaining half of the drill's story and is pre-existing.

## What the 295 tests do not exercise

- A candidate shown to the model that the store will refuse (F1): the refusal is
  tested, the selection is not.
- `stale` caused by a zero-change event in the same scope (F2).
- A model with `maxTokens >= contextWindow` (F3) — no unit fixture sets both fields, and
  the real-host fake model is declared `contextWindow: 128000, maxTokens: 4096`
  (`scripts/test-pi.mjs:138`), so the arithmetic is never stressed there either.
- `ctx.model` undefined on the automatic path (F4); the `unavailable` tests cover only
  the legacy-import cause.
- A prompt containing a path that is *not* the subject (F5); every literal test is a
  targeted question.
- Negative learning fixtures for sentence-initial `always`/`never`/`don't` used as
  ordinary prose (F6); the drill's negatives are all questions.
- A record whose alias is an everyday word (F7).
- `undo` of a metadata-only event while a source is pending (F8).
- `redact()` has no test file of its own; the token shapes in F12 and the cross-line case
  in F11 are untested.
- More than a few dozen records in any store (F10); no timing assertion anywhere.
- The `bun:sqlite` branch (`src/memory/sqlite.ts:8`) in CI.
- A capture that throws (F20), and two processes contending for the write lock during a
  long `beginEvolution` (the multi-process tests in `memory-store.test.ts:245-270` use
  short transactions).
- `/memory` command parsing edge cases (`src/index.ts:212`) beyond the happy paths in
  `index.test.ts`.
- `scripts/test-pi.mjs:184` and `:199` assert absolute non-semantic request counts (17,
  20); every added prompt moves both numbers, which is how a drill commit had to touch
  them. Counting only semantic requests would keep the assertion's intent without the churn.

## Strongest parts of the codebase

- **The store's write discipline.** `BEGIN IMMEDIATE` everywhere, no transaction across
  network I/O, lease + attempt + generation checks before a model result can commit
  (`memory-store.ts:403-417`), and a clean separation of "the model's mistake"
  (`invalid_output`, correctable) from "the store's authority" (`write_rejected`, final) at
  `:424-442`. F1 and F2 are about *what* those checks compare, not whether they exist.
- **Failure handling that never persists free text.** `EvolutionError` with an allowlisted
  code and a validated `Diagnostic` (`recovery.ts:21-29`, `diagnostics.ts:38-49`); HTTP
  bodies inspected for 200 ms and 8 KB then dropped (`http-diagnostics.ts:41-76`).
- **The output contract parser** (`output.ts`): one envelope, no JSON repair, fenced
  output tolerated exactly once, every field allowlisted, and a `field` path the
  correction prompt can cite.
- **Shared accounting across processes**: call windows, route cooldowns and cost
  reservations all live in SQLite (`processing-state.ts`), with the estimate and the run
  forced through one `selectCandidates` so a cheaper estimate cannot admit a larger payload.
- **`scripts/check-doc-constants.mjs`'s original purpose**: every number a reader might
  act on is checked against the constant it describes, and historical mentions must be
  excused by name with a reason. That is why this review found no numeric drift.
- **Release engineering**: pinned actions by commit, read-only default token, integrity
  re-verified from the public registry after publish, refusal to move `latest`
  backwards (`release-policy.mjs`, `check-automation.mjs`).
- **Real-host tests**: `test-pi.mjs` drives an actual Pi process with a loopback model,
  a real Git repository and a failed push; `routing-concurrency.test.ts` and
  `memory-store.test.ts:245-270` use real child processes on one database.

## Recommended fix order

1. **F3** — one function (`answerCeiling`), unblocks a whole class of providers, no
   behaviour change elsewhere. Add a fixture with `maxTokens === contextWindow`.
2. **F1** — filter pinned and newer-than-source records out of `candidates`; move the
   `replacePinned` expectation in `evolution.test.ts:45`; record a reason on authority
   refusals.
3. **F2** — generation counts only memory-changing events; stop charging the source call
   budget for `stale`, or document that it is charged.
4. **F4** — return `false` before claiming when there is no model.
5. **F6 and F7** — the two drill regressions, before the branch merges: gate `DIRECTIVE`
   behind the question test and one-off markers; make alias/concept topic names
   df-rare. Update the shape checks in `check-doc-constants.mjs` in the same change
   (or take F16 first and delete them).
6. **F5 + F15** — paste-aware literals; strip frame suffixes; fix the `usage.md`
   contradiction in the same commit.
7. **F8** — block only removed content on undo.
8. **F10** — tokenised-document cache first (largest win, smallest change), then move
   `selectCandidates` out of the write transaction.
9. **F9** — move the digest to the `message` slot; delimit excerpts.
10. **F11–F14, F18–F20** as time allows; **F17** documentation pass whenever the docs are
    next touched, at minimum the version labels and the `usage.md` contradiction.

## Appendix — what was run

All probes were TypeScript scripts under the session scratchpad importing the branch's
`src/` directly (Node 26 type stripping), each on a fresh temporary state directory:

- `verify-order.ts` (F1), `verify-stale.ts` (F2), `verify-ctx.ts` and three catalog
  scripts (F3), `verify-unavailable.ts` (F4), `verify-trace.ts` and `verify-paste.ts`
  (F5), `verify-directive.ts` against branch and `main` `learning.ts` (F6),
  `verify-topic-run.ts` (F7), `verify-undo.ts` (F8), `verify-perf.ts` at 1k/5k/20k plus
  `verify-tok.ts` and `verify-longprompt.ts` (F10), `verify-redact.ts` (F11, F12),
  `verify-main.ts` (drill diagnosis vs `main`), `verify-race.ts` (a suspected
  `reinforcedAt` lost-update across two store instances — **not reproducible**: `reinforce()`
  is only reached through `finishEvolution`, which always writes an event, so the
  generation check rejects the competing write), `verify-reinforce.ts` (confirmed that a
  restating summary and a user restatement both move `reinforcedAt`).
- Break-the-fix runs: `src/memory/conversation-recall.test.ts` with the
  `incidental-overlap` gate disabled (6 red), with the live budget restored to
  `MAX_HISTORY_TURN_BYTES` (2 red), and `src/adapter/progress-pipeline.test.ts` +
  `src/index.test.ts` with `DIRECTIVE` removed from the cue test (2 red). The working tree
  was restored with `git checkout --` after each and is clean.
