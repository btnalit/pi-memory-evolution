# Conversational recall follow-up

Version 0.2.0 remains unreleased. This change improves automatic **per-user-turn**
recall, not only startup recall, and does not add a special case for a device/topic.
No schema change, production-memory rewrite or additional recall-time model call.

## Reproduced failures

The initial 13 regression groups had **9 failures** on the preceding implementation.
Six groups each exercise Chinese/English questions about a different domain: device,
database, backup, font, coffee and travel. Recall framing could either dilute the actual
subject or retrieve an unrelated memory about the memory system itself. Other failures
covered exact-resource precision, corpus-size sensitivity and learned-alias paraphrases.

A read-only production-database replay separately reproduced the original issue:
a one-word topic found records, while the natural question yielded none. This was not
a missing record, a cwd restriction, an expired job or a need for another model API key.

## Implementation

- **Query planning:** query-only cleanup removes conversational framing while preserving
  actual technical memory questions and exact paths. Stored text is unchanged.
- **Multi-hop context:** a structured plan separates current focus from its supporting
  subject. `SQLite 数据库 → 端口呢？ → 认证呢？ → 继续` retains SQLite and answers the
  authentication question, not the earlier port question. Only bounded active-branch
  user texts/retained user tails supply context; never assistant/tool/injected text.
- **Topic barriers:** new subjects, including unknown subjects, do not inherit the last
  successful database match. Reset phrases break the chain. Context-free continuation
  stays empty. Unindexed single-character subjects are not treated as empty chit-chat.
- **Multi-signal ranking:** words, exact identifiers, bilingual concepts and validated
  learned aliases contribute field-weighted evidence. Unseen terms get base weight,
  not maximum IDF. Coverage, current-focus and supporting-subject gates, mandatory
  literal constraints, mild length normalization and relative relevance filtering
  protect precision rather than indiscriminately lowering thresholds.
- **Question vs answer:** quoted questions in replay/incident notes have reduced weight
  and cannot qualify by themselves. Facet deduplication is separated by evidence kind,
  preventing a project-state mention from hiding a preference that answers the question.
- **No accidental learning:** asking `What do you remember about X?` does not turn the
  question into a learning source simply because it contains `remember`. Explicit
  `Please remember that ...` instructions still work.
- **Inspection:** `/memory explain` shows the last automatic snapshot, including actual
  injection count/bytes. `/memory explain <query>` previews an explicit query without
  conversation inheritance or replacing that snapshot. Diagnostics contain bounded,
  sanitized features/IDs/counts/reasons, not memory bodies, and are not persisted.
  They show selection/injection decisions, not whether the model understood them.

The exact scoring rules, lifecycle exclusions and limits are in [design.md](design.md).
The digest still contains at most three claims / 2,048 UTF-8 bytes, with reserved trust
and provenance guidance and an explicit warning that this is not the full inventory.

## Validation

- **164 tests passed**, including existing transactional/lifecycle/privacy tests and new
  conversational regressions. Strict TypeScript checking and package dry-run inspection
  are included in `npm run check`.
- Six domains × six natural-question forms, positive learned-alias paraphrases and
  unsupported-paraphrase negatives. These are deterministic fixtures, not a universal
  natural-language benchmark or an independent semantic-accuracy evaluation.
- Multi-hop current-focus tests distinguish SQLite authentication from PostgreSQL
  authentication and from SQLite's old port answer. Unknown facets do not fall back to
  old answers; new subjects and resets do not resurrect older matched topics.
- Real installed Pi 0.85/Bun with a **loopback fake model** verifies actual outgoing
  provider digests, fresh cross-directory sessions, Chinese/English question framing,
  multi-hop refinements, unknown-topic barriers, diagnostics, forget and no accidental
  learning calls. Existing model/auth, actual temporary Git work, failed-push and timer
  recovery checks remain included. No live paid provider was used for these tests.
- A separate **read-only SQLite connection** evaluated 14 distinct query/context cases
  against a snapshot of **154 real records** (17 executions including repeats). The
  original natural questions now retrieve the stored topic. Both language variants of
  the project-boundary question rank the actual preference first, not a replay note
  quoting the question or a weak storage-directory fact. Unknown/reset/context-free
  cases remain empty. Model/auth questions retrieve corresponding implementation facts.
  The connection reported `total_changes() = 0`. Sample timing was 0–56 ms per evaluation
  (empty queries at 0 ms); this is one local sample, not a performance guarantee.

The live Pi process may independently learn from later completed turns; these counts
refer to the diagnostic snapshot, not a promise that the running database stays frozen.

## Limits and activation

This is **local concept/alias-assisted retrieval**, not an embedding service or a general
LLM semantic reasoner. Learned aliases extend vocabulary without translating at recall
time; absent aliases, unsupported paraphrases can still be missed. Conservative subject
and literal gates can miss useful ambiguous references. Negation, complex comparisons
and arbitrary coreference are not fully understood. The system deliberately prefers no
injection over filling a quota with unrelated memories.

Selection is not truth verification. Historical states may be stale even inside their
seven-day window, and inferred claims/aliases remain provisional. Existing facts are
not marked complete or rewritten merely because the algorithm changed.

The local Pi installation references the checkout directly. Run **`/reload`** (or restart)
to activate the updated extension in an existing session. This change does not migrate
or reset the database. It neither commits nor publishes the repository automatically.
