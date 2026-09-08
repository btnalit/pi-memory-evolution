# Progress pipeline follow-up

This **unreleased 0.2.0** follow-up fixes reproduced capture/nomination failures after
`a3c5943`. It keeps schema 5, ordinary recall's relevance/identity gates, automatic model
selection/authentication, and the existing transactional write boundary.

## Reproduced failure chain

A read-only investigation found a stale project-state claim absent from all five saved
progress target lists in the diagnostic snapshot; all five corresponding model events
had zero changed records. The model could not update an ID it never received. `done`
was processing status, not proof of learning.

Replay of the tool-heavy development session showed:

1. A long implementation run ended with an assistant error, so no progress source was
   captured despite completed tool operations.
2. In its successful continuation, a 64-entry context window retained only “continue”.
   The last-eight-unique-paths policy also dropped the repository root. No targets meant
   no source/job, even though a full test result existed.
3. In the later commit/push/restart turn, only the last eight tool results survived;
   restart inspection displaced the real commit/push result.
4. Reusing answer retrieval for update nomination required an exact absolute repository
   path. A project-state claim containing only its bare repository name could not qualify.
   Per-path top-2 and answer redundancy gates further restricted update opportunities.
5. The unmodified state was less than one day old. Its freshness factor was about 0.914,
   so time-based decay did not exclude it. Age is not evidence of task completion.
6. The user's explicit three-part requirements statement did not match the learning cue
   regex and no compaction occurred, so it was not captured as a user statement.

This does not prove every old clause was false. Test completion and a commit do not imply
full product acceptance; updates must preserve unverified or still-pending clauses.

## User context and natural learning

The public active-branch context facade remains the only context source. A bounded scan
now considers up to 4096 entries and 4096 messages, retaining at most six sanitized user
texts of 2048 bytes each. Repeated consecutive topic-less continuations share a slot.
Reset and unknown-topic barriers are kept, not replaced by an older successful topic.
Assistant/tool text, raw compaction summaries, injected digests and slash commands do not
supply user topics. Retained user tails remain supported. No full-session archive replay,
cross-branch traversal or persistent topic cache was introduced.

`memory/learning.ts` distinguishes explicit cues and natural declarations such as:

- 我比较在意的三大功能……这些你觉得做得怎么样？
- 我们的核心需求是……
- 我希望系统每次都能自动……
- 我喜欢茶。
- Our priorities are …
- Our project must …

A statement may precede a question seeking feedback. A plain recall question, quoted
example, vague continuation or one-off execution request is not a new durable requirement.
This is conservative pattern-based intent recognition, not universal language understanding.
The active model still extracts provisional claims and may return no update.

A mixed statement/work turn can capture a separate user source and progress source.
Their model calls use the serial queue and retain separate write authority: tool output
cannot create preferences, and a user request is not proof an operation succeeded. This
can cost two background calls rather than the old single cue call that discarded progress.
Source idempotency and existing retry caps still apply.

## Evidence selection and interruptions

The progress inspector considers only the current user turn, with at most 4096 trailing
messages. It requires linked call/result IDs, a work request and at least one recognized
work operation. Allowed observation tool names are bash/write/edit/read/grep/find/ls;
unknown/custom tools are not automatically trusted as work observations.

Operation classes prioritize evidence instead of blindly taking the newest eight:

| Priority | Examples |
|---|---|
| 5 | git commit/push/merge/rebase/cherry-pick |
| 4 | test/build/process runners; git status/log/show/diff/ls-remote |
| 3 | file edits/writes and recognized mutation/deployment commands |
| 0 | supporting inspection |

The priority is a retention hint, not a success/verification classifier. Git arguments,
Python/Node scripts or exit code alone do not prove a particular task completed. The
model must inspect the actual operation/output, failures and qualifications. Ties favor
newer observations; the chosen set is restored to chronological order for the model.
The last eight most important observations fit within a 28,000-byte JSON budget; budget
pressure removes lower-priority observations first. Each stored operation is at most
1024 bytes, output at most 2048 bytes, with head/tail previews and redaction. Request/report
remain bounded. The payload exposes omitted counts and scan limits, not an illusion of
complete evidence. More than eight important distinct outcomes can still be omitted.

`completion` is either `completed` or `interrupted`. Error/aborted final assistant responses
retain already observed tool operations but omit the assistant report. This never certifies
the whole work item as finished. A request, unmatched result, unfinished tool-use response
or assistant-only report cannot substitute for observed work. Captures made while the
foreground signal is cancelled remain eligible for existing automatic recovery; they do
not require another compaction or a manual evolve command.

`memory_recall`/other internal memory tools and operation arguments referencing the owned
state directory are excluded. A mixed shell command mentioning that directory may be
conservatively omitted rather than feeding the extension's own records back as independent
corroboration. This is not a universal detector of indirect self-reference through renamed
files or custom tools.

There is **no new per-tool disk journal**. Hard kills before `agent_end`, work outside the
bounded scan, lost tool-result pairs, unsupported commands and missing retained context
remain limitations. Extending those guarantees requires a separate persistence design,
not calling an interrupted task complete.

## Operation resources and update nomination

A small non-executing shell lexer extracts hints from explicit `cd` and `git -C`, including
quoted paths and simple environment prefixes. It does not treat quoted semicolons or
heredoc source bodies as independent commands. Dynamic paths/substitutions/globs and
unsupported shell syntax lose hints rather than being executed or guessed.

File operations can discover a real checkout root by walking parent `.git` markers
without running git. Operation resources come from arguments, not output or the current
cwd alone. At most 16 resources are retained, in operation-priority order; up to eight
complete paths of at most 512 bytes each are included in the model payload as host hints.
Longer paths can still participate locally, but are not truncated into a fictional model
resource path.

`memory/progress-targets.ts` is separate from question-answer retrieval:

- Candidates are existing project states in the capture origin, excluding pinned,
  forgotten, conflicted or explicitly incorrect records. Expired states remain eligible
  for fresh evidence.
- Operation resource paths or explicit bare project names provide subject hints; a
  generic cwd/origin is not authority. Distinct absolute resources with the same basename
  cannot qualify by falling back to generic commit/push words.
- User-topic matches are a separate fallback, not tool-output-derived subject inference.
- Pending states receive nomination priority over historical completed notes.
- Up to eight IDs are nominated without per-path top-2, answer deduplication or an
  answer-relative score cutoff. Ordinary recall's path and topic gates are unchanged.

Current nomination scores are resource path 60 / explicit project name 50, plus two per
matched user feature (up to eight), plus 20 for recognizable pending state wording. They
are deterministic candidate heuristics, not learned confidence. Oldest evidence/ID break
ties. Eight candidates are still a cap; large/multi-project tasks may need additional
observations and cannot be assumed fully updated in one pass.

The model still must identify the same subject/fact and use exact `replaces` IDs. Store
checks still enforce candidate authority, source time, generation, pinning and origin.
A nominated resource is not proof of completion. New preferences/facts from progress are
rejected, and unsupported compound clauses must remain unchanged.

## Diagnostics and activation

`/memory learning` shows a bounded, sanitized transient capture/nomination snapshot:

- natural/explicit learning intent and number of captured user statements;
- no-work-request/no-work-observation/unfinished-response versus observed work;
- scan limit, linked/ignored/retained/omitted observation counts and completion type;
- no-update-targets, already-captured or progress-captured;
- operation resources, selected IDs and candidate reasons, without memory bodies.

It also shows recent actual model transaction changed-record counts. `/memory status`
includes those persistent outcomes and explicitly says `done` means processed/retired,
not necessarily learned. Zero changes remain distinguishable from a provider failure.
Diagnostics do not persist raw provider responses or claim to know why the model chose
not to change a fact. User feedback and aliases are not inferred from lookup frequency.

No schema migration or old-record rewrite is needed. Reload/restart activates the new
code. Updating alone does not reopen completed jobs, replay old transcripts, backfill
previously missed requirements or invent completed states. New observations/statements
and compaction use the repaired pipeline. Back up state before version changes as usual.

## Validation

- **215 passing tests**, strict typecheck and package inspection via `npm run check`.
- Synthetic runtime tests cover long work/continuation, early commit/test preservation,
  interruptions, cancelled foreground recovery, operation identity, ambiguous paths,
  same-origin/pin/lifecycle boundaries, natural requirements, separate mixed-source
  authority, replay idempotency, JSON expansion budgets and zero-change diagnostics.
- Real installed Pi/Bun with a loopback fake model performs an actual temporary Git
  commit and failed push followed by **12** diagnostic tool results. The early result
  reaches the model, the bare-project pending state is nominated and updated, and the
  next provider payload contains the new partial state with full acceptance still open.
  A natural priorities statement also learns without an explicit remember cue. Existing
  recall/tool/feedback/recovery and model/auth tests remain enabled.
- Read-only replay of three relevant real-session turns (interrupted implementation,
  successful continuation, commit/push/restart) now nominates both previously missed
  stale states. The continuation retains test counts; the commit turn retains the actual
  commit result. The connection reported `total_changes() = 0`.

The real-data replay exercises host selection only, not a paid model consolidation or
production update. It does not claim the historical records are already corrected. The
real-Pi update test uses synthetic data and a fake model, not a multi-day natural-language
accuracy benchmark. See [design.md](design.md) and [core-quality.md](core-quality.md).
