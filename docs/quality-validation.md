# Recall and progress quality follow-up

This follows `f6599d0` (global cross-session recall), not the earlier directory-isolation
review. Version 0.2.0 remains unreleased. Validation was run on Node 26.8.1 and the
installed Pi 0.85 standalone Bun host.

## Three causes and changes

1. **Weak secondary recall:** partial CJK fragments and repository-name components could
   qualify unrelated records. Raw overlap lacked enough query coverage and relative
   relevance filtering. Retrieval now uses words/concepts, exact literals, document
   frequency, coverage and redundant-facet filtering. Body/alias/origin-identifier field
   factors are 1/0.8/0.2. Source IDs/current cwd have no authority bonus. Generic internal
   `scope` fields are not treated as cross-context semantics: doing so distorted frequency
   weights and could promote storage-directory facts over a cross-session preference.
2. **Stale progress:** ordinary work turns did not enter the cue/compaction-only evolution
   loop. Completed work can now supply linked tool observations, including failures,
   targeting at most 8 existing same-origin project states. Expired states can be updated
   with fresh evidence, but forgotten/conflicted/pinned states cannot. Explicit operation
   paths are not crowded out by generic task words. Store checks prevent even accidentally
   widened candidates from relabeling facts as project progress.
3. **Cross-language misses:** literal matching could not connect an English question to
   the Chinese preference. A bounded bilingual concept map supports existing records;
   optional model-generated bilingual aliases extend matching without recall-time model
   calls. Aliases are validated, persisted, copied defensively and undoable. Alias-only
   changes do not refresh evidence dates; correction clears old aliases. Excerpts apply
   the same literal/prose boundary, rather than locating a topic word inside an earlier
   filename and omitting the actual relevant passage.

The detailed formula, caps, update restrictions and migration contract are in
[design.md](design.md). No project files/configuration are modified by memory evolution.

## Validation

- **122/122 tests**, strict TypeScript checking, and package dry-run inspection.
- Runtime coverage: **100% lines / 91.44% branches / 98.68% functions**. Coverage is not
  a correctness proof, and host-specific behavior also needs the real-Pi check below.
- Real Pi RPC tests passed repeatedly using fresh processes, separate working directories,
  a shared temporary memory database and a loopback fake model. They verify active-model/
  auth reuse, cross-session recall, contextual continuation, topic changes, Chinese queries,
  learned aliases, provenance, forget and absence of approval prompts.
- The real-host test also performs a real local Git commit in a temporary repository,
  followed by a push that fails because no remote exists. Actual tool events reach the
  progress model input. The fake model replaces “not committed or pushed” with “commit
  created; push pending”; the next turn receives the updated state. Three memory-model
  calls are observed: two explicit learning inputs and one work observation.
- Schema-2-to-3 upgrade tests preserve records/history/dates. Malformed aliases/targets,
  invalid model updates, forgetting queued targets and manual correction are covered.
- One synthetic 600-summary/1,800-record sample: capture 662 ms, reopen 1 ms, cold/warm
  recall 196/99 ms. Segmentation is memoized only within a query for repeated text/origins;
  this is a local timing sample, not a large-corpus performance guarantee.

## Real-data replay, separately read-only

A direct SQLite read-only connection (`query_only`, no `MemoryStore` construction) read
146 existing records. Nine query/context cases passed; the connection reported zero
changes and the existing schema marker stayed at 2. No migration, correction, deletion,
model evolution or paid call was triggered by this replay. The active Pi session may
independently capture new memories; these counts are a snapshot, not a frozen fixture.

- The Chinese project-boundary question selected the actual cross-session preference.
- The equivalent English question ranked that preference first, with a relevant provenance
  qualification second; the weak storage-directory fact was no longer selected.
- The reload/injection question selected two relevant rules, not old CI/setup filler.
- The model/auth question retrieved corresponding implementation/reuse context.
- Context-free continuation and unrelated networking topics were empty. A memory-topic
  continuation recalled the preference; a later topic switch did not revive it.

## Limits and activation

These checks establish orchestration and bounded regression cases, not general live-model
accuracy. Tool results/reports and aliases remain untrusted evidence; generated states
are provisional. A quoted command is not execution, and a successful commit/test is not
proof of a successful push. The model can still make semantic mistakes.

The vocabulary is not universal translation; corpus-sensitive thresholds can miss useful
results. Cross-origin semantic identity is not automatically resolved. Upgrading does not
invent completion for existing stale entries or replay old tool transcripts. New eligible
observations/compactions can update tracked progress; exact-ID correction remains available.

The local installation references the checkout. Back up with Pi stopped before schema
upgrade, then reload/restart all instances sharing the database. Status should report
`SQLite ok (schema 3)` and global topic-based recall. Older builds require a matching
backup for rollback; do not manually downgrade the schema marker. No npm/tag release or
live paid-provider/multi-day TUI validation was performed.
