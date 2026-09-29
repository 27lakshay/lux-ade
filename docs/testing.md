# Test ownership and gates

## Workflow for a change

1. Choose the layer that exercises the changed behavior using the table below. Read its
   fixture guide before adding coverage. Finish this step with a test that reaches the
   behavior through its owning boundary.
2. For a bug, write a regression test and observe the reported symptom fail before fixing it.
   After it passes, temporarily remove only the fix, observe the same behavioral failure,
   restore the fix and rerun the test. Preserve existing user changes throughout.
3. Use a focused runner command or inspect `pnpm test:affected --base main --list` during
   development. An affected run reports its selected scope; full integration acceptance
   requires the complete ordinary suites.
4. When adding or moving tests, follow [discovery ownership](#adding-or-moving-tests) and
   run `pnpm test:discovery`. Finish with every maintained test assigned to its actual runner.
5. Before finishing a change, pass `pnpm check:static` and the acceptance that proves its
   changed behavior. Run `pnpm test:acceptance` when complete ordinary integration evidence
   is required. Execute any affected external suite with its own prerequisites.
6. Report commands, scope, results and the run directory. Name failed, skipped, unexecuted
   and prerequisite-blocked coverage alongside passing checks. Completion requires the
   relevant native reports and a final summary; a running manifest is incomplete evidence.

| Changed behavior | Test layer and fixture guide |
| --- | --- |
| Pure fingerprints, reducers, codecs, schema round-trips or reconciliation decisions | Deterministic in-process tests beside the code |
| Renderer stores, components, DOM events or focus | Vitest browser tests beside the code; [browser tools](#browser-watch-and-ui) |
| Daemon/runtime behavior through CLI, SDK or public protocol | Real-process headless E2E on [shared protocol fixtures](../e2e/protocol/README.md) |
| Native windows, preload/IPC, desktop startup or application interactions | Built Electron E2E against scratch backends and mocks; [desktop fixtures](../e2e/desktop/README.md) |
| Packaged executable or bundled resource behavior | [Candidate acceptance](#packaged-candidates) against the identified artifact |
| Installed providers, authenticated live flows, host capabilities or devices | The explicit installed-provider, live, system or device suite below |
| Application latency, throughput or memory | [Isolated application performance](#isolated-application-performance) |

Correctness tests retain zero retries, independent mutable scratch resources and their
behavioral assertions. Resolve a flaky failure with a regression and fixture or product fix.
Keep diagnostic tracing separate from timing samples.

### Reusing evidence and deciding what to rerun

During a fix, rerun the focused regression and affected checks. Run the required static gate
after the final edit. Broaden testing when changed behavior, a failure or an unresolved
integration risk warrants it. Reuse a passing full acceptance result only while its tested
implementation, fixtures and relevant configuration remain applicable; state subsequent
changes and the focused checks that cover them.

Benchmark to answer a named performance question. Choose the workload, source states, cache
conditions and worker settings before collecting samples. Once the comparison answers that
question, record the result and stop. Repeat a benchmark only when a relevant implementation
change, failed sample or unresolved measurement uncertainty warrants it. Ordinary validation
does not require repeated full-suite timing matrices; use [the benchmark procedure](#repeatable-benchmarks)
for controlled comparisons.

## Discovery ownership

Run `pnpm test:discovery` to check maintained test ownership. Add `--json` for the file inventory,
historical exclusion reasons and Rust binary/test enumeration. The static gate runs the same
check, so a newly added unassigned test fails before acceptance can succeed.

## How discovery works

The independent inventory includes tracked and untracked, nonignored JavaScript/TypeScript
`.test` and `.spec` files, Python `test_*.py` entry points, and the named live probe. Deleted
files cannot satisfy ownership. Generated/ignored dependency files are outside this inventory.

- Node execution and discovery share the same glob definitions.
- Deterministic providers share the actual runner's file selection.
- Vitest supplies browser test files through `list --filesOnly --json`.
- Playwright supplies actual discovered cases through `--list --reporter=json` for each config.
- Rust uses nextest enumeration of the compiled workspace with native-terminal enabled. Cargo
  owns module registration and inline Rust test discovery; this check does not parse Rust bodies
  or claim it can detect an unregistered function that Cargo never compiles.
- Python static entry points are shared between execution and discovery. Standalone installed
  provider and live checks are listed explicitly; they require the environments described below.

The validator rejects missing files, unassigned tests, empty required suites, stale historical
exclusions, missing exclusion reasons and conflicting ownership. Exclusions use exact paths
rather than broad patterns. Documented protocol/fault/system file overlap is permitted because
one spec can contain cases belonging to separate suites. Native discovery regression tests verify
that the fault cases are a correctness subset and that load/system cases stay separate.

## Adding or moving tests

Place new tests in their runner's existing layout and run discovery. If adding a new suite or
changing its layout, update its native runner configuration and discovery adapter together.
For Node and Python checks, update the shared catalog instead of duplicating selection in the
gate. Register a new standalone external check explicitly; a filename alone must not silently
opt it into current acceptance. Do not fix a discovery error by adding a blanket exclusion.

The complete file list and reasons live in the output of `pnpm test:discovery --json`;
`scripts/test-catalog.mjs` contains the small shared Node/Python catalog. Playwright uses
`e2e/suites.ts`; Vitest retains its own configuration. There are no hardcoded case-count budgets.

## Python and historical coverage

The current static gate now retains these checks from the older shell gate:

| Entry point | What it proves |
|---|---|
| `test_bootstrap.py` | Archive safety, bootstrap verification and packaging helpers |
| `test_build_identity.py` | Source/build identity invalidation |
| `test_first_launch.py` | Python workspace-environment startup policy |
| `test_native_accessibility.py` | The retained AppKit bridge's native child handling; macOS only |

These checks supplement current acceptance; the AppKit harness does not prove Electron UI
accessibility. Non-macOS execution still reports the existing native harness skip.

The catalog explicitly retains older Python runtime, provider, review, service, worktree and
native-client checks as historical migration references. Their per-file reasons name assumptions
such as automatic `ADE_ROOT` workspace creation, the old terminal wire protocol, old receipt
payloads or the removed `ade-client` executable. They were outside both default gates before this
overhaul. Their files and assertions remain intact. Exclusion does not establish equivalent
current coverage or authorize deletion; migration parity remains unverified and must be reported
as such when reviewing acceptance or removing historical code.

Installed-provider checks (`test_codex_loopback.py`, `test_claude_loopback.py`, and the OMP and
OpenCode loopback files) use real installed binaries against local fixtures. The OpenCode and
OMP `live.test.mjs` files also belong to installed-provider acceptance: their startup/session
checks never send model prompts. The Python live-provider probes need explicit opt-in and can
consume provider usage.
The catalog assigns these checks to external suites without running them during discovery.
Current provisioning and execution evidence is tracked by the live/system acceptance work.

## Required checks

`pnpm check:static` enforces formatting, contracts, architecture/parity, types, lint, dead code,
builds, in-process tests, deterministic providers, browser tests, the retained Python/native
checks, discovery and Rust tests. `pnpm test:acceptance` adds complete protocol and desktop
acceptance with the required builds.
Performance, packaged and live/system evidence remains separate and requires explicit execution.
Playwright and native test summaries require at least one passed case. All-skipped runs fail;
mixed runs retain each skip and its reason beside the executed cases. Commands that provide
tool/build evidence rather than test records retain their own command outcomes.

Installed-version acceptance has a dedicated `pnpm test:providers:installed` command covering
Codex, Claude, OpenCode and OMP. `--provider <name>` narrows the run; `--list` only lists it.
It checks prerequisites before execution and uses the existing isolated loopback fixtures.
The default run includes a joint Codex/Claude daemon handoff stage;
`pnpm test:providers:handoff` runs that stage alone with local HTTP fixtures. Native provider
authentication and full R005 acceptance remain unverified.
See [provider instructions](../providers/README.md#installed-provider-loopback-acceptance) for
build requirements and the distinction between native test records and Python command evidence.

## Opt-in live Python probes

`ADE_RUN_LIVE_PROVIDERS=1 pnpm test:e2e:live codex` requests the configured Codex provider.
The command also accepts `claude` and `omp`, with the existing tool, cancellation and approval
probe options. `pnpm test:e2e:live:handoff --run` requests active-turn handoff for Codex and Claude.
These commands can consume provider usage and require installed, authenticated native providers.
Missing opt-in, executables or workspace dependencies fail before daemon startup. Authentication
preflight remains unverified; executable availability alone does not prove account readiness.

Both probes isolate ADE sockets, profiles, data and the debug file secret store under a temporary
root. Native provider HOME/config discovery remains available for the explicitly requested live
run. Inherited ADE profile destinations and mock adapters are discarded. Reports omit raw provider
error text. The basic probe writes a unique `live-provider-<id>/summary.json`; handoff writes a unique `live-handoff-<id>/summary.json` and emits its
provider outcomes and failures as JSON lines. Local HTTP-fixture validation of these scripts does
not count as hosted authentication or paid-provider acceptance.

The basic probe reports its selected F021 provider scenarios; an approval probe also names F038.
The handoff probe reports the R005 daemon-restart scenario. These mappings identify relevant
requirements and leave full requirement acceptance unverified: a provider smoke or one restart
scenario cannot prove every condition in the requirement register.

Python probes wait for each captured runtime PID to exit before removing scratch state. A stop
acknowledgement alone does not establish exit. Missing endpoints with live owned processes fail
cleanup and retain their scratch directory. The earlier interruption report established exit code
130 but missed a surviving runtime; that process was verified as owned and stopped. The corrected
cleanup passed delayed-exit, missing-endpoint and diagnostic-retention regressions, followed by
local provider and interruption checks.

## Live desktop acceptance gaps

`pnpm test:e2e:live:desktop` selects the built and packaged desktop continuity cases for F010.
Its opt-in setup checks native provider executables, debug backend and desktop build outputs,
Claude workspace dependencies, the existing `CLAUDE_CONFIG_DIR` required by the packaged case,
and the package candidate. These checks do not establish authenticated account readiness.

The current conversation tab content returns `null` in `tab-content.tsx`. The live desktop
specs still require a composer and transcript, so their UI assertions remain unverified.
Reports retain this known gap in `acceptanceScope` and F010 on every selected case, including
cases left unexecuted by missing prerequisites. The assertions remain intact; headless or
bridge-only acceptance does not establish this UI behavior.

The built-desktop daemon uses the existing test file secret store in its scratch directory.
Both it and Electron discard inherited ADE profiles and mock settings while keeping native
provider authentication discovery. Packaged release daemons refuse the test file store and
use the existing system secret-store behavior with a scratch ADE profile. That release path
remains unexecuted here. Packaged live checks omit raw native error details and no longer
attach daemon logs to shared reports, because those logs may contain provider account data.

## Device fixture acceptance

`pnpm test:e2e:devices` builds the backend, SDK and CLI, then runs all six maintained device
spec files. `pnpm test:e2e:devices:only` uses existing builds and fails on missing prerequisites.
The command runs the same device cases that ordinary protocol acceptance includes; it does not
remove them from that gate. These cases require macOS and Python 3 on PATH and use real daemon/runtime processes
with scripted simulator and Android tools. No physical device or installed mobile SDK is used.
The inventory test queries the real macOS screen-permission API without requesting capture.

Reports carry `acceptanceScope` for F098, F099 and F100, label physical-device acceptance
`unexecuted`, and preserve the F098 display/application input `known-gap` case. Passing this
command proves the scripted-tool scenarios only. Real simulator, emulator and physical-device
acceptance remains pending; this command does not substitute for that evidence.

## Playwright run evidence

Normal protocol, fault, system, performance, desktop, package and live commands retain evidence
under a unique `test-results/runs/<suite>-<id>/` directory. The runner prints the path. Each run
contains native Playwright JSON, `run.json` metadata, `summary.json`, and an artifacts directory.
Workers inherit the run ID so their attachments remain under that same directory. A started run
without a final summary is incomplete, even if its last console line looked successful.

Metadata includes revision, dirty state, OS/architecture, Node/Playwright versions, command,
workers, shard and wall time. Set `ADE_TEST_CACHE_CONDITION` to a descriptive cache condition when
measuring; otherwise the value is explicitly unspecified. Build duration is unavailable in a
Playwright-only run and is recorded as null. The summary keeps summed test time separate from
wall time and preserves failed, interrupted and unexecuted evidence. Missing native evidence or
duplicate test records fail summary validation. The adapter also validates expected shard
membership before accepting merged results.

Package, system and live global setup write `prerequisites.json`. A missing prerequisite keeps
exit status nonzero and marks `summary.json` with `failureCategory: prerequisite-unavailable`.
The reporter accepts only a marker from the current invocation, so a reused run directory cannot
reuse an earlier prerequisite outcome. Markers contain no environment or credential values.
Case records preserve requirement IDs from their native suite and case titles. When prerequisites
fail, a separate native `--list --reporter=json` invocation retains the selected inventory in
`prerequisite-inventory.json`. The summary lists these cases under `unexecutedTests` with zero
attempts and `evidence: native-discovery-only`; they do not count as executed or passed tests.
Selection filters and shards remain intact. Stateful `--last-failed` and UI invocations cannot
be reconstructed this way and explicitly report unknown inventory. Discovery failures also leave
coverage unknown, while preserving the original prerequisite failure.

Protocol tests attach `fixture-phases.json` with repository creation, profile startup, fixture
use, shutdown and process-ledger cleanup durations. Phases overlap: fixture use includes dependent
fixture setup and test execution, while teardown includes shutdown and ledger cleanup. Do not
sum them into total wall time. Phase status describes the measured fixture operation; the native
test result remains authoritative for assertion failures.

Scratch repositories use an immutable Git template for their local test identity and disabled
commit signing. Git copies the settings into each repository; config files, indexes, objects,
hooks and exclusions remain private to that test. Use `ScratchRepo.status()` when polling:
it disables Git's optional index refresh so observation cannot take the lock needed by a daemon
Git operation.

The shared command runner forwards cancellation to its process group. If a package-manager
launcher exits first, the remaining runner processes get the rest of the five-second cancellation
window to tear down fixtures, including detached runtimes. Processes still in that group at the
deadline are force-stopped. An interrupted run remains interrupted even if teardown succeeds.

Failed protocol runs retain their scratch root and bounded log-tail attachments. Diagnostic reads
allocate at most 1 MiB per log attachment; full logs remain in the retained scratch root. Timing
attachments survive ordinary failure and handled interruption. Hard process termination can
prevent final reporting and must remain incomplete evidence.

Explicit `--reporter` overrides use Playwright's native semantics and replace the configured
reporters. Discovery commands intentionally use `--list --reporter=json` without writing a run
summary. The static gate, provider command and browser package test command also retain run summaries as described below.

## Static, provider and browser reports

`pnpm check:static`, `pnpm test:providers` and the desktop package `test` command print a unique
run directory. The static summary records every required stage before execution and atomically
updates its state, command, duration and native reports. A missing native report fails the stage
even when its command exits zero. Failed or interrupted runs preserve completed stages and leave
later stages pending. A summary still marked running is incomplete evidence.

Node and provider runners retain native JUnit, Vitest retains native JSON, Python unittest uses
its standard lifecycle callbacks to retain case results, and nextest writes native JUnit directly
into that run's directory. The generated nextest configuration preserves the checked-in settings
and enables ignored-test reporting. Discovery evidence separately labels the intentional Rust
subprocess helper. No shared JUnit file is used as proof of a particular run.

Summaries distinguish per-stage wall duration from summed native test duration. Unavailable
worker counts and test durations are null; commands retain explicit worker/filter options.
Machine, revision, dirty state, available tool versions and cache description accompany the run.
Stage logs retain at most the first 1 MiB; native reports retain runner failure details, and
protocol fixture logs retain bounded tails. Native AppKit and static tools without a test-runner
report remain command outcomes with logs, not invented case counts.

Run `python3 scripts/native_report.py <report.json-or-xml>` to inspect a native report's normalized
cases. Missing, malformed, duplicate, failed, retried or zero-pass evidence produces a nonzero
exit. Node file records emitted by unmatched name filters count as skipped files rather than
executed passing cases; matching tests in other files can still establish a passing run.
The JSON summary and raw artifacts stay in ignored output directories for later CI upload.

## Repeatable benchmarks

Install the optional pinned Hyperfine 1.20.0 with
`python3 scripts/install_tools.py hyperfine`. Ordinary tool installation and acceptance
exclude this optional dependency. Release archive SHA-256 values are pinned in
`scripts/tools.json`; the installer verifies them before extraction.

Use `pnpm test:benchmark --suite protocol --runs 3 --workers 5 --warmups 1 --prepare build --cache warm`
for the full protocol suite. To measure a representative subset, append
`-- --grep 'boot'` and retain that exact filter for comparisons. Supported suites are
`acceptance`, `static`, `providers`, `browser`, `protocol`, `desktop`, and `build-backend`.
Both measured runs and workers are mandatory. Preparation is either `build` (recorded
outside the measured repetitions) or `existing` (the caller supplies built outputs).
Warmups default to zero and are recorded separately when requested.

The worker count controls Playwright, Vitest, Node test files, nextest and Cargo compilation
in benchmark children. Provider suites execute sequentially; Bun's OMP tests and Python
checks remain serial. This is a concurrency limit, not a promise that every runner keeps
that many workers busy. Stop other test runs and watchers before collecting comparisons.

For a separate cold backend compilation baseline, use
`pnpm test:benchmark --suite build-backend --runs 1 --workers 3 --prepare existing --cache cold-build`.
Each sample uses an empty Cargo target directory and disables sccache. Dependencies,
compiler installations and OS filesystem caches remain warm; this does not measure a clean
machine or dependency download. Cold compilation disallows warmups and build preparation.

Each benchmark directory contains `benchmark.json`, Hyperfine's native `hyperfine.json`,
and a directory per measured iteration or `warmup-N`. Each sample retains stage metadata,
bounded logs and its suite's native reports. Failed or interrupted samples fail the command;
missing iterations or native exit evidence cannot produce a passing aggregate. Read median
and range from Hyperfine; three samples do not justify tail-percentile claims. Compare the
same source state, filter, build mode, worker count and cache conditions. A dirty Git revision
alone does not prove two source states are identical.


## Complete local acceptance

Run `pnpm test:acceptance` for static checks, protocol correctness and the built desktop suite.
Use `pnpm test:acceptance --list` to inspect the execution order. Optional `--workers N` and
`--desktop-workers N` control protocol and desktop concurrency. Case filters belong on the
individual suite commands; the aggregate rejects them to retain full acceptance.

The static gate builds the SDK once before typechecking, then builds CLI and desktop consumers.
It retains Rust doctests as a separate Cargo step because nextest does not execute them. The
aggregate builds the backend binaries and invokes the protocol and desktop `:only` commands.
It does not repeat the fault subset. Every test still creates its own mutable scratch resources.
Standalone `pnpm build` and individual E2E commands retain their build prerequisites.

The aggregate writes its manifest under `test-results/runs/acceptance-<id>`. Its child static,
protocol and desktop reports live there too. A failed build, missing child report, failed case
or unexecuted required case prevents success and leaves subsequent stages pending. Known skips
remain visible in child counts; a passing command does not certify their missing coverage.

To benchmark complete local acceptance, use
`pnpm test:benchmark --suite acceptance --runs 3 --workers 5 --prepare existing --cache warm`.
Each sample runs the aggregate's own build prerequisites and retains static, protocol and desktop
reports under its `acceptance/` directory. The benchmark worker count applies to both protocol
and desktop; ordinary acceptance retains its separate desktop default. This full-command timing
includes required builds, unlike a protocol-only sample prepared outside the measurement.


## Worker defaults

Protocol correctness uses half the available CPUs, rounded down, with a minimum of one
and a maximum of five. Desktop correctness uses two workers. `ADE_E2E_WORKERS` and
the runner's `--workers` option allow an explicit override. CI currently supplies three
workers; hosted timings remain pending. Correctness retries stay at zero.

On the ten-CPU, 24 GiB Apple M4 used for this overhaul, two complete five-worker
protocol samples passed in 489.0 and 533.7 seconds. One complete three-worker sample
passed in 649.8 seconds; another exposed a terminal signal race, so it does not support
a reliable timing estimate. Three desktop samples with the same eight cases had a
median of 13.43 seconds at one worker and 8.67 seconds at two. These are worker
comparisons, not an overall overhaul speedup.

Separate process-tree diagnostics sampled peak RSS sums of 2.37/3.68 GiB for three/five
protocol workers on the 30-case representative selection and 1.59/2.69 GiB for one/two
desktop workers on all eight cases. Shared pages can be counted more than once and
short-lived processes can be missed. These diagnostics do not establish unique physical
memory, an instantaneous peak, or clean execution timing.

Keep CI sharding out until hosted measurements justify it. Ideal two-way splitting of
the 650-second local three-worker sample could save about 325 seconds before overhead.
Provisioning, repeated setup, artifact transfers, queueing and billed runner time are
unmeasured. No paid runner changes or nextest archives are needed for the current graph.

## Packaged candidates

Build a local candidate with `pnpm package:mac`. The builder writes an external
`Lux ADE.app.candidate.json` sidecar containing its source revision, dirty-state source
digest, build time, target and a digest of the complete application contents, permissions
and internal links. Keep the app and sidecar together when copying a candidate. The
sidecar is a local build identity record; it is not a signed provenance attestation.

Run the existing artifact explicitly:

```sh
pnpm test:candidate --app "/absolute/path/Lux ADE.app"
```

This command runs packaged protocol, current desktop and retained legacy desktop cases
against the same artifact. It never builds or substitutes development executables. Missing
executables, missing/invalid metadata, incompatible native architecture, escaping links,
content changes and acceptance failures return a nonzero exit. Native reports record the
verified candidate identity; the aggregate rechecks its contents after successful tests.
Release executables use scratch profiles, scratch HOME and staged deterministic providers.
Metadata stays outside the app so recording it cannot alter the packaged signature.

Eight retained `package-desktop` cases assume profile controls absent from the current
renderer. The ninth, launch refusal, failed waiting for a window and during teardown.
Their acceptance is pending. The `package-desktop-current`
project proves the built workspace shell, window relaunch and bundled-provider bridge;
bridge sends do not prove composer interaction. For explicit partial validation:

```sh
pnpm test:candidate --app "/absolute/path/Lux ADE.app" \
  --project package-protocol --project package-desktop-current
```

The selection record labels this as partial scope. A passing partial run does not satisfy
the retained legacy cases or release acceptance. Neither building nor testing publishes
the app. Signed distribution, notarization, other targets and authenticated providers
need their separate release checks.

## Focused development selection

Inspect the selection before running it:

```sh
pnpm test:affected --base main --list
pnpm test:affected --base main --workers 5
```

Both modes use the same rules. The base resolves to an exact commit. Selection includes differences
from that commit to HEAD, staged changes, unstaged changes and nonignored untracked files. Renames
contribute both the old and new paths; deleted files still select their consumers. A missing or
unreadable base and unsupported paths select all ordinary correctness suites with an explanation.

| Changed area | Selected checks |
|---|---|
| Markdown in the documentation or local tracker | Complete static gate |
| Renderer or Electron code; desktop fixtures | Static gate and built desktop acceptance |
| Rust, contracts, SDK, CLI or providers | Static gate, complete protocol and desktop acceptance |
| Protocol fixtures/tests, shared runner inputs, lockfiles or unknown paths | Static gate, complete protocol and desktop acceptance |

The static gate includes contract generation checks, API parity, all in-process Rust tests,
providers and browser tests. The selected E2E stages reuse the acceptance command's build order
and report validation. Their processes and scratch resources retain the normal isolation and
zero-retry policy. Failures and interruption stop the remaining stages.

This is a development selection, not full integration or release evidence. Use `pnpm test:acceptance`
for complete ordinary acceptance. Performance, packaged, live and system suites keep their explicit
commands and prerequisites; changing those tests still requires their separate execution.

Execution retains `selection.json` beside `summary.json` under `test-results/runs/affected-<id>/`,
including every selecting path and reason. `--list` runs no checks and creates no report directory.


## CI acceptance

The `Checks` workflow defines five required jobs and one aggregate check:

| Job | Local entry point | Evidence |
| --- | --- | --- |
| `javascript` | `pnpm check:static --group javascript` | Formatting, contracts, architecture, retained Python checks, builds, typecheck, lint, dead code, JavaScript, providers and browser tests |
| `native` | `pnpm check:static --group native` | Rust formatting, native accessibility, Clippy, discovery, nextest and doctests |
| `protocol` | `pnpm test:e2e:protocol:only --workers 3` | Complete protocol correctness suite |
| `desktop` | `pnpm test:e2e:desktop:only --workers 3` | Built Electron acceptance against scratch profiles |
| `dependencies` | `node scripts/ci-dependencies.mjs` | Existing cargo-deny advisories, bans and sources policy |

The complete local `pnpm check:static` runs both static groups. A registry rejects
unassigned, duplicate or missing stages before either group runs. Dependency checks retain
the existing policy: license enforcement is not enabled in `check_dependencies.sh`.
A license allowlist remains a separate project decision.

The application jobs use macOS 15. The dependency job retains its existing Linux placement.
Each job provisions pinned tools; browser jobs install the matching Chromium. Protocol and
desktop jobs restore only declared build outputs. The archive manifest checks the source
revision and content, OS, architecture, tool versions, compiler/SDK, backend build command, native profile/features and build flags.
It validates file hashes before replacing outputs. Profiles, repositories, sockets and test
data are created afresh by the fixtures and are never transferred.

Jobs have 45-minute limits. Superseded pull-request runs are cancelled. Reports upload even
on failure and expire after seven days; build artifacts expire after three days. The
`Acceptance` aggregate runs after all five jobs and rejects missing reports, unsuccessful
or skipped jobs, incompatible revisions, incomplete stage inventories and failed cases.

When branch protection is configured separately, require the job named **Acceptance** from
**Checks**. Confirm the check identity from the first hosted run before changing protection.
No remote settings have been changed. Hosted provisioning and full execution remain unverified
until a separately authorized push or dispatch runs this workflow.

Validate workflow edits with the optional pinned tool:

```sh
python3 scripts/install_tools.py actionlint
.ade/tools/bin/actionlint -shellcheck= .github/workflows/check.yml
```

This validates workflow syntax and expressions. It does not prove hosted runner provisioning
or successful artifact transfer; those require execution evidence.


## Browser watch and UI

The desktop package has explicit focused commands; its ordinary `test` still runs once:

```sh
pnpm --filter @ade/desktop test:watch src/renderer/src/commands/when.test.ts
pnpm --filter @ade/desktop test:ui src/renderer/src/commands/when.test.ts
ADE_TEST_HTML=1 node scripts/test-browser.mjs src/renderer/src/commands/when.test.ts
```

`test:ui` runs watch mode without opening a browser automatically. Open the local URL printed
by Vitest, including its access token. Select a failed case to inspect its assertion and use the
UI rerun control after a fix. Stop the watcher with Ctrl+C before benchmarks. The pinned
`@vitest/ui` development dependency matches Vitest 5.0.2. Optional HTML output lives in the
browser run's `html` directory beside native JSON; terminal reporting remains enabled.
[Vitest UI documentation](https://vitest.dev/guide/ui) distinguishes interactive reruns from
static HTML reports, which only display recorded results.

The one-shot launcher uses `ADE_TEST_WORKERS` as a default; an explicit `--maxWorkers`
value takes precedence. Check test-order independence with a reproducible seed:

```sh
node scripts/test-browser.mjs --maxWorkers 5 --sequence.shuffle --sequence.seed 20260929
```

Browser tests in one file can retain pointer position after React cleanup. Tests that
need a neutral pointer should call `userEvent.unhover(document.body)` before mounting
the next window. Keep counters and mutable mocks inside each test's fixture. Preserve
real pointer clicks and browser isolation when fixing order-dependent failures.

For application performance, use the existing
[desktop debugging workflow](agents/desktop-debugging.md), React profiling and Chrome DevTools.
Those tools answer rendering and process-performance questions. Keep their recording overhead
out of test timing measurements. Electron failure traces and focused examples are documented
in the [desktop E2E guide](../e2e/desktop/README.md).


## Optional Rust watcher

Bacon 3.26.0 is an optional local convenience. It reruns focused Cargo jobs and keeps
compiler/test diagnostics in a terminal view. It does not make compilation itself faster.
Install it explicitly; default tool provisioning and CI do not require it:

```sh
python3 scripts/install_tools.py bacon
pnpm test:rust:watch                         # ade-core check
pnpm test:rust:watch clippy-core
pnpm test:rust:watch test-core -- -E 'test(contract::devices)'
pnpm test:rust:watch check-runtime           # native-terminal enabled
pnpm test:rust:watch --list-jobs              # native configuration validation
```

The launcher supplies the same Rust/tool paths as the static gate and forwards cancellation.
Project jobs in `.config/bacon.toml` invoke `scripts/cargo.mjs`, preserving normal feature and
cache handling. The default watches ade-core and its manifests/toolchain. The runtime job also
watches runtime/platform and native inputs. Build output and test reports do not trigger jobs.

Use `c` for core Clippy, `t` for core nextest and `r` for the runtime check. Press `q` or Ctrl+C
to stop. Stop the watcher before benchmarks so background jobs do not affect timing. Nextest
uses the existing zero-retry CI profile. This watcher does not run protocol or desktop acceptance.
Run `pnpm check:static` for the full static gate and `pnpm test:acceptance` for full local acceptance.

The same focused command remains available without Bacon:

```sh
node scripts/cargo.mjs nextest run --locked -p ade-core --profile ci -E 'test(contract::devices)'
```

The pilot keeps Bacon for its automatic focused reruns and readable diagnostics. A source edit
produced a compiler error with its location; restoration returned the job to green. An ignored
build output did not cause another job. Cancellation during a fresh runtime compilation left
no observed descendant running. These are usability and cleanup results, not a suite-speed claim.
See [Bacon configuration](https://dystroy.org/bacon/config/) and its
[nextest analyzer](https://dystroy.org/bacon/analyzers/).

## Lint-rule fixtures

`node --test scripts/oxlint-plugin-ade.test.mjs scripts/oxlint-fixture-report.test.mjs` checks the
rules through the real Oxlint binary and verifies the diagnostic harness. Fixtures run in one
Oxlint invocation per rule, with separate files and an individual Node test result for every
case. Positive fixtures must produce no diagnostics; negative fixtures must produce exactly
the expected error. Unknown files, incomplete reports and process failures fail the harness.
Node's `--test-name-pattern` can focus a case; its rule batch is loaded only when needed.


## Isolated application performance

Run these workloads alone on an otherwise quiet machine:

```sh
pnpm test:performance --list
pnpm test:performance
pnpm test:performance --grep 'startup:'
pnpm test:performance --grep 'terminal streaming:'
pnpm test:performance --grep 'ten agents' --diagnostics
```

The command builds the debug daemon/runtime, SDK and CLI, then runs exactly one
Playwright worker with zero retries. Build time is a separate stage. A selected pattern
still requires the `@load` tag. Alternate configs, extra workers and retries are refused.
Listing does not build or run workloads. Ordinary protocol/fault correctness excludes
`@load`, including when performance environment variables are inherited.

| Workload | Input and sample count | Completion criterion |
| --- | --- | --- |
| Existing load | 10 synthetic agents, 20 real terminals, 3 services, 5 scripted browser tabs, 10,000 imported synthetic messages and a 5,000-line diff | Sustained, idle and daemon-crash recovery phases retain their assertions |
| Startup | 5 independent fresh homes, profiles and databases; warm binaries/OS cache | Daemon hello names its runtime, catalog responds, terminal snapshot arrives and a shell arithmetic result is observed |
| Terminal streaming/resync | 3 independent profiles; 360,000 distinct output lines each; viewer throttled to 200 bytes/ms until a resync | SDK/TerminalFeed/Ghostty viewer catches up, agrees with a fresh snapshot and receives a subsequent live marker |

Reports live under `test-results/runs/performance-command-<id>/`. Each workload attaches
`performance.json` and an append-only `performance.jsonl`. They record raw success/failure
durations, incomplete operations, machine and revision, build configuration and executable
hashes, actual workers/retries, input sizes and readiness criteria. Metadata labels dirty
checkouts; retain the matching working tree when comparing them. JSONL records are written
outside each timed operation; they still add workload overhead between operations. Durations
from polling include detection latency. Do not sum overlapping measurements as wall time.
An empty summary has a count of zero and null percentiles, never a zero-latency claim.

`--diagnostics` runs the same workload separately and records process-tree resource observations.
For the load workload it also checks memory observation and bounded queues at sustained, idle
and recovery checkpoints. Its samples are labelled diagnostic and must not be pooled with
ordinary latency samples. Neither mode enables tracing or forced GC. Capture CPU profiles,
heap snapshots and Electron traces separately when investigating a result.

The admission p95 target of 250 ms and recorded echo target of 50 ms remain provisional;
only admission is asserted. Startup and resync observations do not establish latency budgets.
Debug measurements are not release measurements. Providers and browser ownership are scripted;
these runs do not measure model latency or Electron rendering. Electron startup/rendering,
production conversation rendering and the known slow full-history CLI TTY replay gap remain
outside this workload's verified coverage. The ordinary resync correctness cases remain in
`e2e/protocol/terminals2/resync.spec.ts` with their existing scope.

### Explicit timing policy for protocol acceptance

Only the receipt scheduler and selected plugin lifecycle cases opt in through
`ade.profile({ env: { ADE_E2E_TIMING_POLICY: 'short' } })`. The daemon validates the
control before opening stores or taking runtime ownership. Debug daemons accept
only the fixed `short` preset; release daemons refuse every value, including an
empty value. Ordinary profiles use production intervals.

| Interval | Production | Explicit debug preset |
| --- | ---: | ---: |
| First scheduled receipt prune | 60 seconds | 5 seconds |
| Receipt scheduler tick | 30 seconds | 100 milliseconds |
| Plugin activation deadline | 15 seconds | 5 seconds |
| Plugin deactivate deadline | 5 seconds | 1 second |
| Superseded host drain grace | 15 seconds | 2 seconds |

The six-hour receipt recurrence, receipt retention, command invocation deadline,
health probes, watcher cadence and 10-second debounce cap keep their existing
values. Pure due-time and drain decisions take explicit timestamps. Acceptance
still uses real processes, durable receipts, handler effects and process exit;
the preset changes the intervals, not the outcomes or replay rules.
