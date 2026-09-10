# Recovery, provider fallback and budgets

Memory learning defaults to **Pi's active agent model**. With no session override this
is Pi's configured default. The extension never sets the foreground model, creates a
second credential store, changes provider configuration, or probes models to rank them.
It discovers available models through Pi's registry and uses registry completion/auth.

## Provider fallback

Cross-provider fallback is enabled by default. If the default route is unavailable,
learning may send the sanitized source and selected candidate memories to another
**already-configured, available Pi provider**. This is a privacy/cost boundary: configure
an explicit allowlist or disable fallback below if some configured providers must not
receive memory data. Installing this update does not require per-request approvals.

The active model is always first when eligible. Backups must support text. Another model of
the **same** provider is never chosen automatically, because it shares that provider's
credentials and account quota. Naming one in `fallbackModels` overrides that: it is the only
redundancy available when Pi has a single configured provider, and it is then used for
model-specific failures (`rate_limit`, `invalid_output`, `output_limit`, `context_limit`)
but still skipped for `auth` and `quota`, which no sibling can escape. An explicit
fallback list defines priority; otherwise known catalog input/output price, non-reasoning
preference and stable model ID order choose among available backups. Unknown/zero prices
are not assumed free. Catalog availability is not proof of working credentials or credit.
At most two models may receive any one source by default, including the primary.

All source/model budgets are checked in a SQLite write transaction. Selection does not
grant call authority. Provider cooldowns are shared across sources and Pi processes.
A cooldown for A does **not** change a source's retry timestamp or prevent B from working.
Last-checked ordering moves temporarily unroutable sources behind other eligible work.

## Error policy

| Result | Automatic action |
| --- | --- |
| HTTP 401/403 | Cool down that provider for 15 minutes; try an allowed other provider. Pi owns auth resolution/refresh. |
| HTTP 402 or fixed quota/billing code | Cool down the provider for 1 hour or a later supplied reset; try another provider. |
| HTTP 429 without a known quota code | Cool down that **model** for at least 60 seconds and at least `Retry-After`, since tpm/rpm ceilings are usually per model; try another provider, or an allowlisted model of the same provider. |
| HTTP 408, timeout, network/5xx failure | Delayed retry; two recent transport failures cool down that model for 15 minutes and permit fallback. |
| Context overflow or HTTP 400/404/422 | Do not resend unchanged requests to that model immediately; cool it down for 1 hour and permit a compatible backup. |
| Invalid JSON / output truncation / **broken output contract** | Initial attempt, at most one corrective prompt naming the rule that was broken, then an alternate model. Three output failures pause the source; two failures do not authorize repeatedly probing the same model. |
| Unsafe/unauthorized write or recognized safety/refusal | Reject and pause that source. No fallback to circumvent safety or write guards. |

A claim the store refuses is classified by *whose* mistake it is, because the two need opposite
handling. A **broken output contract** — a progress source answering with a plain addition instead
of replacing its nominated record, a replacement id that was never shown, the same target replaced
twice, a replacement that changes evidence kind, a cyclic batch, or aliases that fail validation —
is the model's error. It is reported as `invalid_output` with a
`reason` naming the rule, so the correction prompt can cite it and a sibling model may try. A
**refusal on the store's own authority** — a pinned record, another origin's record, a record
already newer than the source, or model output that still redacts to a placeholder — is not
correctable: the same evidence is refused however often it
is offered, so it stays `write_rejected` and stops the source rather than burning the budget. The
last of those is a deliberate refusal to retry rather than an inability: a correction would resend
the same unredacted source to another call and, because `invalid_output` permits cross-provider
fallback, to another vendor. One exposure and a stop is the cheaper outcome.
| Stale result | Re-read on a bounded delayed retry; not counted as a provider-health failure. |
| Cancellation / shutdown / reload | Release the lease without adding a failure; already-reserved requests may still have consumed quota. |
| Unknown error | Safe generic category and bounded transport retry; no guessing that arbitrary error prose means insufficient credit. |

Generic source backoff is 1 minute, 5 minutes, 15 minutes, then 1 hour, with up to 20%
positive jitter on runtime failures. Route failures can try one alternate immediately;
there are at most two immediate attempts per queue item, not a sleep/retry loop. The
120-second deadline is **per attempt**, not an outer timeout that also kills its backup.
Request deadlines are clamped to the source's remaining cumulative time budget. A provider
ignoring cancellation cannot commit late output, but remote execution/billing may continue.

HTTP status/error codes are observed before the underlying SDK consumes failed responses,
using request-local fetch only for verified supporting APIs: OpenAI completions/responses,
Azure responses, Codex responses, Anthropic messages and Mistral conversations. Codex memory
requests use HTTP SSE; foreground transport is unchanged. Other adapters retain their normal
transport. Complete structured JSON errors (including Google SDK errors) can also supply a
fixed status/code; arbitrary text is never searched for status-like numbers or echoed.
Only known code values, numeric `Retry-After`/reset metadata and raw stop enums are used.
Unsupported/opaque SDK errors can still be generic `provider`; no universal balance API is
claimed. Error-body inspection is transient, bounded to 8192 bytes and 200 ms, never stored.

Input planning drops lower-priority existing candidates when a conservative byte/token
estimate exceeds the chosen context window. It does not truncate facts or progress JSON to
pretend they fit. If the original evidence still cannot fit, that route is rejected. Model
mistakes and provider-specific tokenization remain possible; this is not exact token counting.

## Optional configuration

Create `recovery.json` **in the memory state directory**, not in Pi's settings file. Reload
all Pi processes sharing that directory after changing policy. Defaults are:

```json
{
  "crossProviderFallback": true,
  "fallbackModels": [],
  "callsPerHour": 20,
  "sourceCalls": 4,
  "sourceModels": 2,
  "timeoutMs": 120000,
  "sourceTimeMs": 300000,
  "dailyEstimatedUsd": null
}
```

`fallbackModels` optionally contains exact `provider/model-id` strings, in priority order.
Only models Pi reports available are considered. It does not override the default model
or configure authentication. `crossProviderFallback: false` confines learning to the active
model. Invalid policy fails closed with a fixed error, never prints configuration contents.

Limits apply together:

- **20 reservations per rolling hour across all models/providers/processes**, not 20 per
  fallback model. An exhausted shared budget cannot be bypassed by switching providers.
- **4 reserved calls, 2 models and 300 seconds per source** by default. Reservations include
  failed/preflight/cancelled attempts conservatively; they are not exact server billing counts.
- One persisted format-correction allowance survives cancellation/reload. Safety validation
  and transactional all-or-nothing writes apply equally to every backup model.
- The older five-failure safety cap is also retained, including crashes and pre-upgrade work.
- `/memory evolve [source-id]` may override source backoff/route cooldown/source caps for
  **one** explicit attempt, without clearing counters. It cannot bypass shared request or
  estimated-cost ceilings and does not loop through backup models. Settled jobs are not rerun.

`dailyEstimatedUsd` is disabled by default because provider catalogs can contain absent,
zero, outdated or non-billing prices (subscriptions and local models are common). Set a
positive value to enforce a rolling 24-hour **catalog-estimated** spending ceiling.
Unknown pricing fails closed under this optional ceiling. Reservation uses a conservative
input-byte bound, maximum configured pricing tier and output allowance; returned usage/cost
replaces it when available. Missing usage and cancelled/error responses are not assumed
free. These estimates are not account balance, billing receipts, or a guaranteed invoice cap.
Actual provider accounting can differ. Token counts, estimates and unknown-cost counts are
shown separately from Pi's foreground session totals.

## Diagnostics and upgrade

`/memory status` shows the current default, allowed routes, provider/model cooldowns,
source attempts/calls/output failures/time, shared budget and recent selected-model outcomes.
A successful fallback can show one informational notice per route pair/hour. Failures and
pause summaries are also deduplicated across reloads, not re-armed by unrelated successes.
No exception bodies, credentials or failed model text are persisted in diagnostics.

Schema **2–6 upgrade to 7**. Stop Pi and back up the whole state directory first; restart or
reload all processes after updating. Claims, IDs, histories, forgetting and evidence dates
are preserved. Existing v6 call receipts seed source counts/model history where available;
missing history is not invented. Known v6 route-contaminated waits are separated from the
original source backoff. Earlier paused five-failure jobs are not indiscriminately reset.
Older code rejects schema 7; rollback requires a matching backup, not editing the marker.

Empty/missing legacy input no longer consumes the one-time import opportunity. Supply valid
ledgers and use `/memory import [directory]`. A v6 completed/zero-count marker is reopened
only when its saved digest proves a recognized empty snapshot and no migration event exists.
A real consumed ledger with no derived claims remains completed; zero count alone cannot
justify replay over later corrections/forgetting. Originals and copy-only archives are kept.
