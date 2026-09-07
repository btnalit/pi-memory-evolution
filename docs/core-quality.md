# Core memory quality: evidence, aging, feedback and second lookup

This is the next **unreleased 0.2.0** development step. It improves the three core
requirements without introducing an approval queue, vector service or another model
provider. The default path remains automatic capture/evolution and per-user-turn recall.
It is an evidence-policy implementation, not a claim of independently verified memory.

## Evidence and automatic updates

New records have an optional, host-assigned `evidence` object:

```text
basis:    summary | user_statement | tool_observation | manual_correction
method:   local | model | manual
sourceId: source event or manual action identifier
at:       evidence timestamp
```

Summary extraction is labeled `summary/local`; model consolidation from a summary is
`summary/model`, not user testimony. Claims from explicit user learning statements are
`user_statement/model`: the source is the user, but the extraction is still inferred.
Completed-work observations are `tool_observation/model`, only for nominated project
states. A failure observation is still an observation, never automatic proof of success.
Literal `/memory correct` creates `manual_correction/manual` evidence. Manual action
identifiers and their actual before/after states are retained in event history; they do
not imply a separate raw-summary row.

The model's allowed output fields remain kind/content/replaces/searchTerms. It cannot
set evidence, confidence, verification, utility or feedback. Existing evidence/feedback
is supplied to the background model as historical data, and store guards enforce the
write policy regardless of its interpretation.

### Conservative replacement

All existing subject/origin, pin, generation, source-time, nomination and transactional
checks still apply. A replacement cannot change the memory kind to escape its evidence
policy. Ordinal source priorities are:

| Evidence | Priority |
|---|---:|
| Unknown | 0 |
| Summary | 1 |
| User statement about a fact/project state | 2 |
| User statement about a preference/decision | 3 |
| Tool observation about project state | 3 |
| Literal manual correction | 4 |

`confirmed` records and explicit `accurate` assessments are also protected at priority 4
for replacement. These are source appropriateness rules, **not truth probabilities**.
A current explicit user learning/correction statement may supersede earlier testimony.
A fresh, linked tool observation can update project progress even if its earlier state
was manually corrected: correcting “pending” must not freeze progress forever. Neither
exception overrides pinning, source-time or origin checks.

A lower-priority proposed replacement does not overwrite the stronger old record. Its
new variant (including a variant locally extracted from that same source) is quarantined
as `conflicted`; duplicate additions in the same model batch cannot bypass this. Existing
unrelated variants are not silently quarantined. History records how many weaker
replacements were withheld. Original evidence remains recallable. The transaction is
undoable and the processed job is not repeatedly billed as a failure.

An explicit incorporated user reaffirmation or fresh progress observation can refresh
unchanged content's evidence date. Pure aliases and repeated summaries cannot. If a
replacement reuses an already stored target value, incorporated newer evidence is
attached instead of leaving the target's old date/source unchanged. New content does
not inherit old utility/accuracy feedback. A literal correction clears old aliases and
feedback; undo restores the actual prior metadata.

**Limit:** conflict detection still depends on the model identifying a `replaces` target
in its bounded same-origin candidate set. Arbitrary contradictory additions, paraphrases
and cross-origin identities are not automatically resolved. Multiple source events are
not treated as independent corroboration; repeated summaries may share the same root
observation. There is no reinforcement count or model-generated confidence score.

## Gradual aging and relevance-first ranking

Aging is computed at read time; no periodic writes, deletion or artificial timestamp
refresh is required. All times are numeric and negative ages clamp to zero.

```text
freshness = floor + (1 - floor) * 2 ** (-ageDays / halfLifeDays)
```

| Kind | Half-life of the decaying portion | Floor | Hard recall expiry |
|---|---:|---:|---|
| project_state | 3 days | 0.50 | after 7 days |
| fact | 90 days | 0.75 | none |
| decision | 180 days | 0.85 | none |
| preference | 365 days | 0.95 | none |

Pinning sets freshness to 1 and exempts age expiry, but adds no credibility, cannot
revive a conflict, and cannot bypass relevance. Facts/decisions/preferences never vanish
just because they are old. The project-state cap remains unchanged so upgrading does not
revive already expired project claims. This first step classifies by memory kind, not
semantic subtypes such as completed/blocked tasks or volatile configuration facts.

The existing lexical score and subject/literal/coverage/relative-cutoff gates run first.
The 75% relative cutoff is based on **raw relevance**, not quality-adjusted scores.
Only eligible matches are ordered by:

```text
rankScore = relevance * freshness * evidenceWeight * utility * accuracy

evidenceWeight = 1 + 0.04 * sourcePriority
utility       = useful: 1.05, unhelpful: 0.90, otherwise: 1
accuracy      = accurate: 1.05, incorrect: 0.50, otherwise: 1
```

Incorrect assessments are excluded altogether by lifecycle guards; the defensive 0.50
factor never makes them eligible. Pin/date/ID resolve remaining equal rank scores. The
constants are conservative policy choices, not statistically calibrated accuracy or an
online-learned ranker. Changing utility cannot increase source priority. Old records
without evidence metadata get the neutral evidence factor 1, not fabricated authority.

Short named-attribute queries additionally require the named subject and requested
attributes. For example, after SQLite authentication is suppressed, PostgreSQL
authentication and SQLite timeout cannot substitute as answers. This rule applies to
queries with up to four normalized features, one nonnumeric nonconcept subject and an
explicit attribute; generic status/progress words are not mandatory answer tokens.
Explicit origin names may identify a subject, but attribute evidence must be in the body
or aliases. Numeric replacement values are not mistaken for subject names; Chinese
`多少` is query framing, not an entity. This is a bounded grammatical heuristic, not
general entity/coreference recognition.

`/memory explain` exposes raw score, rankScore, source basis/method, freshness, utility,
accuracy and exclusion reasons. Diagnostics still omit memory bodies and are capped at
8 KB in memory. `/memory show` includes persisted evidence/feedback and current quality.
The digest reserves its trust guidance, stays within three claims / 2048 UTF-8 bytes,
and adds evidence basis/method and `aging` (freshness below 0.85). Its source label points
to the current evidence when known; legacy records fall back to their original source.
An `accurate` label means a user assessment, not independent verification.

## Explicit feedback without an approval workflow

Optional controls:

```text
/memory feedback <id> useful
/memory feedback <id> unhelpful
/memory feedback <id> accurate
/memory feedback <id> incorrect
```

Two independent last-verdict slots store utility and accuracy, each with a source ID and
timestamp. Usefulness is a global modest utility preference, not a query-specific
ranking model. `unhelpful` must not imply the fact is false. `accurate` is an explicit
user attestation, not a test result. Neither refreshes the evidence clock.

`incorrect` quarantines the selected claim and active exact duplicates within its origin;
it never touches equal text from another origin. Known queued repeats/observers retire.
It is reversible through actual event undo, literal correction or explicit resolution.
A conflicted/forgotten record cannot be revived by positive feedback. Resolution
preserves the evidence date, preventing stale states from appearing fresh again.

Feedback is local and has no paid learning call. A whole user-role message of the form
`记忆 <24-hex-id> 有用。` or `memory <24-hex-id> is incorrect.` uses the same path. Chinese
有用/没用/正确/错误 map to the four verdicts. The parser does not accept examples, quotes,
questions, multiple statements or vague “wrong”; assistant/tool text is never scanned as
user feedback. IDs outside this conservative syntax remain addressable by the command.
Natural-language correction prose continues through the existing model path, not an
inferred utility score. User-role input has the same trust boundary as existing learning
cues; this is not a separate identity/authentication system for external RPC clients.

Receipts are keyed by source ID plus memory ID. Replaying after restart or undo cannot
reapply the old event. Repeating the same verdict with a new event adds no weight or
memory revision, but its receipt timestamp still prevents an older intervening verdict
from winning. Feedback older than the current content's evidence timestamp is ignored.
There is no retrieval/use count and no credit from assistant success claims or citation
frequency. Feedback changes invalidate stale in-flight model writes transactionally.
Receipts are audit/deduplication data; forget/undo does not securely erase them.

## Read-only mid-task recall

`memory_recall({ query })` registers through Pi's public tool API. It is available unless
a user tool allowlist disables it; the extension never changes that allowlist. The query
is an explicit topic of 1–512 characters. The tool uses the same global relevance,
lifecycle and quality policy, returning at most three claims within 2048 UTF-8 bytes.
A context-free continuation returns no arbitrary recent fallback. Cancellation and store
failures produce safe errors, not invented empty-success results.

No model call is made by the retrieval function, and it neither mutates memory/history
nor persists queries in the memory DB. Pi still stores normal tool calls/results in its
transcript, and the surrounding agent model turns incur normal usage. The agent decides
whether a second lookup is needed; this does not guarantee autonomous gap detection.
Per-user-turn automatic injection remains enabled even when this tool is disabled.

## Schema and activation

Schema 2/3/4 upgrades transactionally to **5**. Missing retry fields are added as before,
plus `feedback_receipts(source_id, memory_id, verdict, at)`. Existing memory/source/event
JSON is not rewritten; IDs, timestamps, tombstones, aliases, source jobs and history are
preserved. Missing optional evidence stays unknown. No JSONL re-import, evidence-date
reset, automatic state revival or fabricated verification occurs.

Reads validate evidence/feedback shape and tool-observation kind, and return independent
copies of nested metadata. Status validates receipt fields in addition to existing
record/job/history integrity. Unsupported schema versions fail before DDL. Old builds
reject schema 5: do not manually downgrade its marker.

Stop all Pi processes sharing the state directory and back up the complete state before
activation. Update/restart all those processes together (or reload after a consistent
backup); do not mix old writers with the new schema. A rollback requires a matching
backup. Development tests use temporary directories, not the production database.

## Validation

- `npm run check`: strict typecheck, **194 passing tests**, package dry-run inspection.
- New tests cover source/method labels, model metadata forgery rejection, weaker
  replacement quarantine, same-batch duplicate/replacement bypasses, conflict-clock preservation, fresh progress after manual
  correction, reused replacements, alias-only stability, aging floors/expiry/pins,
  relevance-first ordering, source-kind appropriateness, feedback replay/restart/undo,
  late/repeated feedback, cross-origin isolation, queued observers, nested-copy safety,
  stale model rejection, malformed metadata, schema-4 migration with unchanged raw JSON
  and history, named-attribute negatives, and bounded evidence injection.
- The real installed Pi/Bun test uses a loopback fake model. It exercises actual
  `memory_recall` schema loading and tool-result payloads, cross-directory lookup without
  memory/history writes, evidence labels, exact-ID feedback without paid learning,
  quarantine and no wrong-subject fallback. Existing work-observation, failed-push,
  startup/timer recovery, model/authentication and conversational tests remain.
- No live paid provider, production-memory migration, or multi-day natural-usage accuracy
  evaluation was performed. Test counts show regression coverage, not real-world recall
  precision or proof of truth. See [design.md](design.md) for unchanged invariants.
