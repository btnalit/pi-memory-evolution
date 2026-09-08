# Testing

Run these commands from a Git checkout after `npm ci --ignore-scripts`.
Tests use synthetic data and temporary directories, not production memories.

## Regression and package checks

```bash
npm run check
```

This runs strict TypeScript checking, the `src/**/*.test.ts` regression suite and
`check:package`. Package checking asserts that the Pi manifest points to the current
entry, host APIs remain peer dependencies, all production TypeScript sources are
packed, and local documentation links resolve to packaged files. Test sources,
helper scripts and memory state must not ship in the package.

`check:package` inspects `npm pack --dry-run --json`; it does not publish to npm.

## Installation smoke test

```bash
npm run test:install
# Or select another installed Pi executable:
PI_TEST_BINARY=/path/to/pi npm run test:install
```

Requires Pi 0.85+, Node.js 22.19+, npm, Git and `tar`. npm scripts can resolve the
bundled Pi from dev dependencies first; use `PI_TEST_BINARY` to select your installed
host explicitly. The script prints the tested host version. The test:

1. Builds and extracts the actual npm tarball, outside the development checkout.
2. Uses real `pi install`, `pi list` and default package discovery—no explicit `-e`
   entry or memory-extension wrapper. Checks `/memory status`, `/memory learning`
   and `/memory explain`, including schema 5, with no checkout `node_modules`.
3. Verifies repeated installation does not duplicate the package setting, then
   removes it and confirms the command disappears while records/history remain.
4. Creates a local Git origin from the packed files and the real lockfile. A
   fixture-only Git URL rewrite redirects an `.invalid` URL to this origin; only
   `file` transport is permitted. No GitHub access is needed.
5. Exercises the native Git installer and its real npm dependency step, updates to
   a new commit, switches from an old pinned tag back to the default branch, and
   verifies source switching and removal preserve schema-5 state.
6. Serves the actual tarball through a loopback npm registry, with a fresh cache,
   then checks native `pi install npm:pi-memory-evolution`, repeat installation,
   normal loading and removal. No host peer packages are served or installed.

The test whitelists child environment variables, gives Pi a fresh agent directory
and HOME, disables startup network operations, and uses private npm caches/config with
lifecycle scripts, audit and update notifications disabled. npm is offline for Git
installation; only the npm fixture uses the loopback registry. Explicit Git updates
need `PI_OFFLINE=0` (otherwise Pi silently skips them), but file-only Git transport
and offline npm still prevent public network access. No real credentials are copied.
Only diagnostic slash commands are submitted; a model turn is a test failure.
Temporary files and child Pi processes are cleaned up.

This checks Pi's package-management and extension-loading path, **not** public
GitHub/public-registry availability, npm publication, every platform or the
behavior of dependency lifecycle scripts. There is no project-specific installer:
users install with Pi's native package manager. These tests are maintenance checks,
not an extra installation step for users.

## Real host with a simulated model

```bash
npm run test:pi
# PI_TEST_BINARY=/path/to/pi is also supported here.
```

This uses actual Pi processes with a loopback fake provider, testing active-model
and auth plumbing, automatic replacement, fresh cross-directory sessions,
contextual follow-ups, unknown-topic barriers, bilingual aliases, provenance,
feedback, forget and the read-only recall tool without approval dialogs.

It executes real Git commits in temporary repositories and intentionally failed
pushes with no remote. Long tool streams verify that early work evidence still
nominates old pending states. Persisted failures, malformed model output, startup
recovery and the real 15-second timer are also exercised; only synthetic retry due
times are accelerated.

These are real-host integration tests, **not live-provider semantic accuracy tests**.

## Live-provider validation

A live-provider run must use Pi's actual selected model/auth, synthetic fixtures and
an isolated memory state directory. Check actual records and transaction history,
not just an assistant acknowledgement or a job marked `done`. Inspect outgoing
provider context for recall, and retain unverified portions of composite states.

Use explicit time/call budgets and preserve failures. Do not replay production
transcripts, copy credentials, or hand-edit production claims to make a test pass.
`--offline` disables Pi startup probes, not model requests. Background learning can
consume provider quota and is not included in foreground session token totals.

There is no paid live-provider command in the repository's automatic checks.
A single successful live scenario does not establish multi-day reliability or full
product acceptance. Historical design/review documents describe their own tested
revisions; see [progress pipeline](progress-pipeline.md), [core quality](core-quality.md)
and [quality validation](quality-validation.md) for context.

No GitHub Actions workflow is configured. Run the local checks before submitting
changes; the Pi-dependent scripts are explicit commands, not part of `npm run check`.
