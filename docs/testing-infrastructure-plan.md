# Testing infrastructure overhaul

Date: 2026-09-29

Status: implementation in progress under the user's separate authorization. Hosted CI,
Rust CI cache trials and complete packaged release proof remain pending. Local Nx adoption is verified. Commits, publishing
and changes to repository branch protection still require separate instructions.

## Outcome

Make every maintained test discoverable and every required check enforceable. Give developers a
short focused feedback loop, retain real-process acceptance for backend behavior, and measure
performance in controlled runs.

The first priority is gate completeness. The second is execution time. Preserve the existing
Node, Vitest Browser Mode, Playwright, Cargo, and nextest runners. Keep pnpm as the JavaScript
package manager; provider scripts may invoke Bun where their runtime requires it.

## Evidence and limits

The audit ran against ADE commit `efc8ad3` on an arm64 Mac with 10 available CPUs, 24 GiB RAM,
Node 24.19.0, installed dependencies, and existing build caches. These are single-run baselines,
not performance budgets or clean-CI estimates.

| Measurement | Result | Elapsed |
|---|---|---:|
| `pnpm check:static` | Passed; sum of reported stage times | 41.8 s |
| JavaScript tests within that gate | 246 passed | 5.8 s |
| Browser tests within that gate | 310 passed, 42 files | 8.4 s |
| Rust nextest within that gate | 862 passed, one intentional subprocess entry point skipped | 15.9 s |
| Backend build with existing caches | Passed | 4.5 s |
| Protocol E2E excluding `@load`, five workers | 976 passed, 15 skipped | 461.3 s |
| Built desktop E2E, two workers | Seven passed | 6.9 s |

The 20-test boot/layout sample took 11.4, 6.2, and 4.0 seconds of command wall time with one,
two, and five workers respectively. The complete protocol run accumulated 2,249 seconds of
individual test duration. Its five-worker execution already had little scheduling waste.

The audit did not measure clean installation, cold compilation, full-suite worker scaling,
CI billing, live providers, the isolated load benchmark, or the reference repos' execution times.
The protocol skips included nine unavailable-package cases, four fixmes, one system-volume
case, and one filesystem-dependent case. A successful local run does not establish release
acceptance or complete v1 coverage.

Verified problems:

- [CI](../.github/workflows/check.yml) invokes [the older shell gate](../scripts/check.sh),
  which omits the JavaScript and browser checks in [the current gate](../scripts/check-static.mjs).
  CI also omits protocol and desktop E2E.
- The current gate's JavaScript glob excludes 21 provider test files. The Claude package command
  names only `bridge.test.mjs`, omitting its task and subagent tests. OMP tests use `bun:test`.
- [Default protocol discovery](../playwright.protocol.config.ts) includes the `@load` benchmark,
  although the README requires it to run alone. The fault configuration excludes it.
- Eighty-four lint-rule tests repeatedly launch oxlint and account for about 5.5 seconds of the
  5.8-second JavaScript suite. The SDK also builds twice within `check:static`.
- The receipt-pruning test waits for a production one-minute schedule. Plugin deadline and
  debounce tests also spend significant time waiting for production intervals.

## Testing boundaries

| Subject | Primary proof | Additional acceptance |
|---|---|---|
| Reducers, fingerprints, parsers, codecs | Deterministic unit tests; property tests for invariants | Public-interface integration where wiring matters |
| Rust and generated TypeScript contracts | Generation check, round trips, invalid inputs | Actual CLI/SDK requests against the daemon |
| SDK projections, journals, reconciliation | Decision tests and focused filesystem/locking tests | Lost replies, reconnect, restart, and durable replay |
| Daemon storage, receipts, runtime ownership | Protocol E2E with real processes and temporary state | Desktop presentation where relevant |
| Provider adapters | Deterministic external protocol fixtures | Separate installed-version and live-provider checks |
| Renderer interaction, CSS, focus, geometry, WASM | Vitest Browser Mode with the host boundary substituted | Electron IPC, native windows, stream bridge |
| Pure renderer utilities | In-process tests; Node only when browser-independent | Browser tests for the surrounding behavior |
| Electron main and preload | Pure policy tests and built-app E2E | Packaged application and supported-OS checks |
| Startup, streaming, latency, memory | Isolated repeated performance workloads | Release-build measurements on controlled hardware |

Keep query, idempotent-command, and effect-command tests distinct. Queries prove validation,
scope, and reads. Idempotent commands prove convergence under repetition. Effect commands prove
receipt replay, payload conflict, crash boundaries, lost replies, and explicit unknown outcomes.
Retain per-operation acceptance even when shared receipt logic has its own unit tests.

Preserve test-scoped profiles, databases, repositories, sockets, and process cleanup. Reuse
immutable binaries and bundles. Keep real processes for crash, recovery, ownership, and
persistence tests. Keep correctness retries at zero.

## Execution model

The command names below are proposed interfaces. Existing commands retain their meaning unless
this plan explicitly changes their discovery. Each new wrapper must propagate arguments,
signals, failures, and cleanup to its underlying runner.

| Command or mode | Responsibility |
|---|---|
| `pnpm check:static` | Existing complete static/in-process gate; incorporate deterministic provider tests and discovery validation |
| `pnpm test:providers` | Deterministic adapter tests using each provider's required runner; explicit exclusion of live/installed-binary cases |
| `pnpm test:e2e:protocol` and `:only` | Protocol correctness; exclude `@load` and artifact-dependent package tests |
| `pnpm test:e2e:protocol:faults` and `:only` | Fault subset; preserve its existing coverage map; no second run when the complete protocol suite already covered it |
| `pnpm test:e2e:desktop` and `:only` | Built-app flows against scratch profiles and deterministic providers |
| `pnpm test:acceptance` | Static gate, protocol correctness, and desktop E2E, with shared build prerequisites executed once |
| `pnpm test:affected --base <ref> --list` | Explain a conservative development selection before execution; include working-tree changes |
| `pnpm test:performance` | Isolated `@load` run initially; later explicit startup, terminal, and memory workloads |
| Package acceptance | Existing packaged desktop suite plus artifact-dependent protocol cases; missing artifacts fail this explicit command |
| Live/system acceptance | Explicitly provisioned provider, device, OS, or credential-dependent suites |

An affected run is a development convenience. It does not replace `check:static` after changes
or the complete integration gate. A dedicated package run must fail when its required artifact
is absent; ordinary protocol correctness should not discover those package tests merely to skip them.

## Implementation phases

### Phase 1 — Make test ownership and selection explicit

Start with `package.json`, provider package scripts, the Playwright configurations,
`scripts/check-static.mjs`, and the test READMEs.

1. Inventory maintained JavaScript, Rust, Python, browser, protocol, desktop, package, live,
   system, and performance tests. Classify old Python scripts by current behavior before
   retaining, migrating, or retiring them. Preserve unique coverage.
2. Define suite ownership using a small shared configuration and runner-native discovery.
   Allow intentional overlaps such as protocol/fault subsets. Require reasons for exclusions.
   Avoid a second framework that parses test bodies or maintains hardcoded case totals.
3. Add deterministic provider execution, covering Claude task/subagent tests and the Node/Bun
   distinction. Clear inherited opt-in flags so ordinary runs cannot activate live tests.
4. Separate load and package-dependent discovery from ordinary protocol execution. Keep
   feature and fault mappings consistent with the new suite locations.
5. Add a discovery check for unassigned maintained test files, stale exclusion patterns,
   conflicting ownership, and accidentally empty required suites. Rust discovery uses nextest;
   enumerate supported Python entry points explicitly where they are standalone scripts.
6. Test the discovery check itself with missing files, new unassigned tests, legitimate subset
   overlap, stale exclusions, and empty-suite fixtures.

Acceptance:

- Every maintained test file belongs to a named suite or a documented historical exclusion.
- All deterministic provider tests run under the required local gate.
- Default protocol discovery selects no load benchmark or package-dependent test.
- Live/system/package commands explain their prerequisites and report unmet prerequisites.
- Existing fault coverage validation passes; exclusions cannot silently remove required evidence.
- `pnpm check:static` passes.

### Phase 2 — Establish durable measurements

Add reporting through runner-supported JSON/JUnit outputs and a small summary adapter.
Keep raw reports in ignored output directories and CI artifacts.

Record commit and working-tree state, OS/architecture, tool versions, suite, selection, workers,
cache condition, build/setup/execution/cleanup durations where observable, pass/fail/skip counts,
and per-test durations. Distinguish summed test durations from wall time. Do not present
unavailable fixture phase measurements as zero.

Instrument the shared protocol fixtures around repository creation, profile startup, test use,
and shutdown/process-ledger cleanup. Preserve diagnostic attachments and cleanup failures.
Capture browser failure evidence explicitly for manually launched Electron pages; do not assume
the standard Playwright page fixture's tracing settings cover `electron.launch()`.

Establish three comparable warm runs and a separately defined clean-build baseline on the same
revision. Report median and range. Use more samples before claiming a reliable tail percentile.
Capture whole-process-tree memory in separate diagnostic runs when profiling changes timing.

Acceptance:

- Successful, failed, interrupted, and prerequisite-missing runs produce truthful summaries.
- Failure diagnostics survive CI cleanup and remain bounded.
- Skip summaries distinguish capability conditions, known gaps, and intentional helper tests.
- Summary aggregation has tests for missing reports, duplicates, failures, and shard merges.
- The baseline records enough context to reproduce a comparison.

### Phase 3 — Reconcile local and CI gates

Make CI invoke the same suite definitions as local execution. First establish equivalent
coverage on the currently supported macOS environment. Move portable work to Linux only after
verifying that it does not require macOS resources.

| CI job | Required responsibility |
|---|---|
| JavaScript/static | Formatting, contracts, boundaries, parity, builds, types, lint, dead code, discovery, Node/provider tests, browser tests |
| Rust/native | Formatting, Clippy, nextest, doctests, and retained Python/native checks |
| Protocol | Complete deterministic protocol correctness with bounded workers |
| Desktop | Built Electron E2E with scratch state and provider fixtures |
| Scheduled/release | Performance, package, live, and system acceptance as explicitly provisioned |

Preserve existing dependency/license checks and useful Python/native checks while replacing
the older gate. Rust doctests remain separate from nextest. Keep a local aggregate command for
the same required checks; CI may split those checks without silently dropping steps.

Build SDK/CLI/backend/desktop outputs once per required dependency path. Key caches by the
relevant lockfiles, toolchains, native features, OS, and architecture. Reused artifacts must
identify the same source revision and build inputs. Never reuse mutable profiles or test data.

Add bounded job timeouts, cancellation of superseded PR runs, and artifact upload on failure.
Run dependency installation without credentials for normal PR checks. Report hosted-CI results
as unverified until an authorized push or workflow dispatch actually runs them.

Acceptance:

- A change that breaks browser, provider, protocol, or desktop tests fails a required CI job.
- CI check membership matches the local aggregate, including doctests and retained Python tests.
- Missing reports and skipped required jobs cannot yield aggregate success.
- A cold CI run provisions its own tools, browsers, and native dependencies.
- Required branch-protection settings are documented; changing remote settings remains a
  separate authorized action.

### Phase 4 — Shorten the development loop

Provide focused commands and runner-native watch examples. Add conservative affected selection
only after suite ownership is stable.

| Changed area | Minimum affected selection |
|---|---|
| Rust contracts or generated contract tooling | Contract/parity checks, affected Rust tests, all protocol and desktop acceptance |
| Shared daemon/runtime admission, receipts, feed, process ownership | All protocol correctness; relevant desktop acceptance |
| A contained backend domain | Domain tests plus its reliability cases; fall back to all protocol tests when mapping is uncertain |
| SDK | SDK tests, protocol clients, and desktop bridge acceptance |
| Provider adapter | Its deterministic tests and provider/lifecycle/recovery acceptance |
| Renderer feature | Related browser tests; desktop tests when host interaction changes |
| Electron main/preload/stream bridge | Main policy tests, browser consumers, desktop acceptance |
| Fixture, runner, lockfile, or suite configuration | Every suite affected by that shared dependency; broad fallback |

Selection must handle renamed, deleted, untracked, and unstaged files. An absent merge base,
unknown path, or unsupported dependency relationship expands selection rather than skipping it.
Explain which rule selected each suite. Keep the initial implementation small; use full runs
where precise selection would need a bespoke dependency graph.

Acceptance:

- Selection logic has regression tests for shared Rust changes, renames, deletions, and unknown paths.
- A focused run cannot print a complete-acceptance success message.
- Full local/CI acceptance remains required regardless of development selection.

### Phase 5 — Remove measured execution waste

Apply one optimization at a time and compare the same selected tests before and after.

1. **Duplicate SDK build:** express prerequisites once while preserving standalone build commands.
2. **Lint-rule startup:** batch fixtures by rule and associate structured diagnostics with each
   case. Preserve exact positive/negative checks and detection of unexpected diagnostics.
3. **Scheduler waits:** separate timing policy from execution. Test due-time decisions with an
   explicit clock. Where justified, add bounded test-only intervals for real-process acceptance,
   with checks of production defaults and release exclusion of test controls.
4. **Fixture cost:** use Phase 2 measurements to decide whether repository setup or process-table
   scans warrant changes. Preserve process identity checks and fail on leaked owned processes.
5. **Browser setup:** profile worker/import/setup overhead before moving pure utilities to Node.
   Keep geometry, CSS, focus, canvas, and WASM behavior in Chromium. Avoid global isolation changes.
6. **Concurrency:** compare representative and full protocol runs at bounded worker counts.
   Measure failures and memory as well as wall time. Tune desktop workers independently.
7. **CI sharding:** introduce only when measurements justify the extra runner/setup cost.
   Merge reports and validate that shard discovery neither omits nor duplicates selected cases.

Acceptance:

- Every claimed saving has comparable repeated measurements and an unchanged assertion scope.
- Timer changes retain real scheduler wiring and lifecycle acceptance.
- No speedup depends on retries, ignored cleanup errors, or reduced required coverage.
- Revert an optimization if it adds instability or maintenance cost without a useful measured saving.
- All required checks pass after each step.

### Phase 6 — Establish performance and release evidence

Run the existing `@load` workload alone with one worker. Record build mode explicitly; its debug
binary results are not release-build performance claims. Add controlled startup, terminal
streaming/resync, and memory workloads as the corresponding product surfaces become available.
Keep synthetic conversation benchmarks labeled until the real conversation surface is built.

Each workload records its input size, readiness criterion, sample count, machine context,
application revision, and failures. Separate unprofiled latency runs from tracing or forced-GC
diagnostics. Keep provisional latency thresholds identified as provisional until repeatability
is established. Performance thresholds must not be inferred from the correctness suite's runtime.

Move package-only protocol cases into explicit artifact acceptance alongside the packaged
desktop suite. Use the actual candidate artifact in a clean environment. Keep live provider,
device, and system tests separate and list which acceptance requirements still lack execution
evidence. Follow the existing machine-safety rules for scratch resources and secret storage.

Acceptance:

- Ordinary correctness cannot start performance or live workloads accidentally.
- Performance results include raw samples, failures, and configuration, not just an average.
- Explicit package acceptance fails when its artifact is missing or incompatible.
- Release summaries identify unexecuted prerequisites and known gaps.
- A backend bridge test is not reported as completed composer/transcript UI acceptance.

## Decisions with material tradeoffs

| Decision | Recommended choice | Cost and alternative |
|---|---|---|
| Required protocol coverage | Full correctness suite before integration | Roughly eight minutes locally today; affected-only gating is cheaper but requires stronger selection evidence |
| CI concurrency | Start bounded; add shards from measured results | Extra runners reduce elapsed time but add provisioning and billing |
| Long production timers | Clock-driven policy tests plus real-process scheduler acceptance | Requires a small timing seam; retaining production intervals everywhere keeps the current wait |
| Browser environment | Keep Browser Mode for browser behavior | Some setup overhead; Node is suitable only for independent pure logic |
| Orchestration tooling | Small scripts over existing runners | Less automatic caching than Turbo/Vite+, but avoids an infrastructure migration before its value is measured |

The phases describe recommendations, not approval of paid runner changes or a broad test-runner
migration. Routine implementation choices can follow the evidence within the approved scope.

## Tooling choices for performance and developer experience

These recommendations extend the plan; they do not authorize installation or migration.
Prefer tools that shorten diagnosis, measure a bottleneck, or eliminate repeated work.
Distinguish faster execution from a more convenient development loop.

### Existing capabilities to retain

The local tooling check confirmed TypeScript 7.0.2, whose `tsc` launcher executes the native
compiler; Vitest 5.0.2; Rolldown configuration in Electron Vite; Oxlint/Oxfmt; nextest; and
sccache 0.18.0 on this Mac. The Cargo wrapper detects sccache when available. Browser tools
already include React Scan, react-grab, React DevTools integration, and Chrome DevTools MCP.

Use those existing capabilities before replacing them. The measured typecheck took 1.9 seconds,
the JavaScript build took 3.0 seconds, and browser tests took 8.4 seconds. None explains the
461-second protocol run. A different bundler or TypeScript compiler would not remove its
process work and production timer waits.

### Small additions and existing developer tools

| Tool | Recommendation | Benefit | Cost or limitation |
|---|---|---|---|
| Hyperfine | Add as an optional measurement CLI in Phase 2 | Repeated command comparisons, warmups, worker scans, JSON output | Measures performance; does not accelerate execution |
| `@vitest/ui` | Add as a development dependency alongside the matching Vitest version | Focused reruns, module graph inspection, browser trace review, HTML results | Improves diagnosis; adds a package and reporting output |
| Playwright UI Mode and Trace Viewer | Document focused use in Phase 2; already available | Select one test, inspect steps and failure evidence | Tracing adds overhead; protocol tests still need daemon/runtime diagnostics |
| Bacon | Optional local trial in Phase 4 | Persistent Rust check/nextest feedback for a selected crate or test | Another background tool; must respect ADE's Cargo wrapper and avoid competing builds |
| `@axe-core/playwright` | Optional coverage addition for representative built UI states | Detects common accessibility regressions | Adds execution time and only covers part of accessibility; not a speed improvement |

Use an explicit Hyperfine repetition count. Its default of at least ten runs would spend about
77 minutes on the current complete protocol suite before any warmups. Start with selected
slow cases, then use a small explicit full-suite validation sample. A warmup must not silently
change a claimed cold-build experiment. Source: [Hyperfine](https://github.com/sharkdp/hyperfine).

Keep Vitest UI aligned with the installed Vitest release. Enable watch/UI mode explicitly because
the desktop package's current `test` script invokes `vitest run`. Preserve terminal reports
alongside HTML reports. Sources: [Vitest UI](https://vitest.dev/guide/ui),
[Playwright UI Mode](https://playwright.dev/docs/test-ui-mode),
[Trace Viewer](https://playwright.dev/docs/trace-viewer).

For manually launched Electron contexts, verify explicit trace start/stop in the fixture.
Recording and retaining traces only on failure still has recording cost on successful cases.
Keep unprofiled performance runs separate. Bacon should watch focused Rust work, not continuously
launch the complete protocol suite. Sources: [Bacon](https://dystroy.org/bacon/),
[Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing).

### Task orchestration: compare before adopting

| Option | Fit for ADE | Tradeoff | Decision |
|---|---|---|---|
| Existing pnpm scripts with a small shared suite definition | Current runner stack, explicit Rust boundaries | Some dependency ordering and selection logic stays in repository scripts | Default for the first phases |
| Turborepo | Task graph, affected selection, local/remote caching around existing commands | Must declare Rust/native/environment inputs correctly; adds cache behavior to debug | First task-runner candidate for a bounded pilot |
| Vite+ | Unified commands and workspace task orchestration, as used by t3code | Broad adoption overlaps ADE's installed Vite/Vitest/Oxlint stack and needs Electron/plugin compatibility checks | Evaluate if unified tooling becomes a goal; do not migrate solely for the measured test runtime |

Turborepo can preserve existing runner commands and express their dependencies. Vite+ also runs
existing package scripts, so evaluating its task runner does not require assuming a full compiler
migration. Choose one experiment; do not introduce both orchestrators. Sources:
[Turborepo task configuration](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
[Vite+ run](https://www.viteplus.dev/guide/run),
[Vite+ migration](https://viteplus.dev/guide/migrate).

A pilot should initially cache builds and deterministic static work. Keep protocol, desktop,
live, system, and performance execution uncached until their inputs and reuse semantics have
been explicitly established. Sharing a build artifact and reusing an old passing test result
are different operations.

Pilot acceptance:

- Existing local commands remain usable and aggregate failures propagate correctly.
- Changes to Rust sources, native features, toolchains, lockfiles, generated contracts,
  provider fixtures, and relevant environment variables invalidate the right work.
- Unknown relationships expand selection. An unchanged JavaScript import graph cannot hide
  a changed daemon binary.
- Missing build outputs are restored correctly or rebuilt.
- Compare one-file edits, no-change runs, and clean CI including cache transfer time.
- Keep the tool only if repeated measurements or substantially simpler orchestration justify
  its configuration cost. Revert the pilot otherwise.

Turborepo publishes an official agent skill and AI-oriented documentation. Review those before
implementing a pilot. Vite+ documents agent/editor setup during migration; review its actual
changes before applying them. Sources: [Turborepo AI guidance](https://turborepo.dev/docs/guides/ai),
[official Turborepo skill](https://github.com/vercel/turborepo/blob/main/skills/turborepo/SKILL.md).

### Rust caching and build reuse

Measure sccache hits and non-cacheable calls first. Its presence does not mean every Rust
compile is cached: incremental compilation and linker-producing crates have material
limitations. Preserve the current local configuration until an ADE benchmark justifies a change.
Source: [sccache Rust support](https://github.com/mozilla/sccache/blob/main/docs/Rust.md).

Trial `Swatinem/rust-cache` in Phase 3 if cold CI compilation is expensive. It caches dependency
artifacts, removes workspace/incremental artifacts, and disables incremental compilation for
its CI use. Measure restore plus build plus save time, and account for any overlap with sccache.
It does not replace transferring the actual backend binaries built for a given revision.
Source: [rust-cache](https://github.com/Swatinem/rust-cache).

Use nextest's existing archive support if Rust test execution is split across runners. Keep the
source revision and target compatibility explicit, and preserve doctests as a separate step.
With a roughly 16-second warm Rust suite, this is conditional infrastructure rather than an
immediate priority. Source: [nextest build reuse](https://www.nexte.st/docs/ci-features/archiving/).

### Experiments that need care

The installed Vitest 5.0.2 exposes `doctor`, which can benchmark configuration alternatives.
Inspection of its candidate selection confirms that pool and filesystem module-cache changes
apply to Node-side projects, not browser projects. The current ADE Vitest suite is browser-only.
An isolation-disabled browser run passing once is insufficient evidence to make that setting
global. Use doctor for bounded experiments where the candidate actually fits the project.
Source: [Vitest performance guidance](https://vitest.dev/guide/improving-performance).

Avoid a Bun-wide runner migration, a simulated-DOM replacement, or a new bundler as the opening
optimization. They change runtime semantics or tooling compatibility while leaving the dominant
protocol work intact. Continue using the existing React and Chrome profiling tools for app
performance; disable their diagnostic instrumentation when collecting clean latency baselines.

### Tool adoption work items

Deliver T1 through T6 in this order. T3 is an optional local convenience; T4 and T5 are measured
trials with explicit keep/remove decisions. A documented decision to omit an unsuccessful trial
completes that work item. It must not block the rest of the overhaul.

For each addition, verify the current official documentation and any supplied agent skill,
select a compatible version, update the appropriate lockfile or tool manifest, and record how
to run it. Keep optional developer CLIs out of production dependencies and normal acceptance
prerequisites. Use the existing tool installer where it fits instead of introducing another one.

#### T1 — Hyperfine and structured timing reports

Depends on Phase 1 suite ownership. Implements the measurement foundation in Phase 2.

1. Add a pinned Hyperfine entry using the existing `scripts/tools.json` and
   `scripts/install_tools.py` provisioning conventions, with verified platform archives and
   checksums. Make its installation explicit for measurement work; ordinary checks must run
   without it. If selective installation needs an installer change, keep existing defaults
   compatible and test that behavior.
2. Add a documented benchmark command for a selected suite or spec. Require an explicit run
   count and worker setting. Keep warmup count and build preparation visible in the output.
   Start with three measured warm runs; do not use Hyperfine's ten-run default on full acceptance.
3. Preserve runner-native JSON/JUnit results for every repetition in separate output directories.
   Export Hyperfine command timings alongside them. Include command, revision, working-tree
   state, machine, tool versions, workers, and cache conditions in the summary.
4. Capture the baseline before changing caching, scheduling, or fixture timing. Keep the
   full-suite baseline separate from representative-case experiments.

Complete when a contributor can repeat the baseline from documented commands, inspect every
sample, and distinguish build time from execution. A failed sample must fail the measurement
command and remain visible in the report. Test wrapper argument handling, failure propagation,
and report aggregation; leave statistical calculation to the tool.

#### T2 — Vitest UI and Playwright debugging workflows

Depends on T1 reporting conventions. Completes the interactive diagnosis part of Phase 2.

1. Add `@vitest/ui` to `apps/desktop` devDependencies through pnpm, matching the installed Vitest
   version, and update `pnpm-lock.yaml`.
2. Add explicit desktop package scripts for browser-test watch mode and UI mode. Retain the
   existing one-shot `test` script for CI. Document filtered invocation so a developer can
   work on one component without launching the entire suite.
3. Add focused Playwright UI examples for protocol and desktop configs to their READMEs.
   For protocol diagnosis, add useful named steps and retain process logs; browser snapshots
   alone cannot explain daemon behavior.
4. Add optional HTML reports alongside terminal and machine-readable reports. Integrate
   Electron tracing with the actual launched context, including teardown on failure.
   Capture a bounded artifact set and document a focused trace reproduction command.
5. Document the existing React/Chrome tools as the app-performance path. Keep them separate
   from uninstrumented test timing; use the existing ADE debugging workflow for inspection.

Complete when a representative failing browser test can be selected, rerun, and diagnosed
from the UI/report, and a failing Electron flow retains its trace and backend logs. Verify with
a temporary deliberate failure, then restore it. Default CI and timing runs must remain headless
and must not open an interactive UI. No permanent failing fixture should enter acceptance.

#### T3 — Bacon for focused Rust feedback

Depends on the established Rust gate and focused-test rules. Belongs to Phase 4.

1. Trial Bacon as an optional local tool. Pin/document the tested version using the existing
   provisioning conventions where supported; do not make it a CI dependency.
2. Add repository job configuration for a focused check, Clippy, and nextest invocation.
   Route commands through `scripts/cargo.mjs` so feature flags, tool paths, and existing cache
   behavior match normal execution. Provide an example crate/filter and an explicit full-run
   command rather than making full-workspace tests the default watcher.
3. Verify source-change detection, useful compiler/test output, clean cancellation, and that
   generated outputs do not create a rerun loop. Document how to stop it before benchmarking.
4. Keep the configuration only if it improves the actual edit/check loop. Otherwise record
   the result and retain documented focused Cargo/nextest commands.

Complete when a source edit triggers only the intended work, results remain readable, and
stopping the watcher leaves no job running. Any provisioning/config changes must use their
native validation tools as well as the repository gate.

#### T4 — Measured CI caching

Depends on T1 measurements and an uncached CI run with the Phase 3 coverage already correct.

1. Record install, compile, test, and artifact-transfer times on a fresh runner. Capture the
   existing sccache hit/miss/non-cacheable statistics without changing global machine settings.
2. Trial a commit-pinned `Swatinem/rust-cache` action in the Rust CI job. Include ADE's native
   build inputs and features in the cache identity where the action's defaults do not cover them.
   Review overlap with sccache and the action's incremental-compilation settings explicitly.
3. Compare first-run misses and repeated hits, including restore/build/save time. Verify misses
   or invalidation after a relevant toolchain, lockfile, native feature, or dependency change.
4. Keep actual backend/SDK/desktop build artifacts tied to their source revision. Transfer them
   only to compatible jobs. Add nextest archives only if Rust execution is actually sharded.
5. Adopt the cache only if total CI time improves without stale outputs. Document the result
   and remove trial configuration if transfer cost outweighs saved compilation.

Complete when a hosted run proves both cache reuse and invalidation and the complete gate
still executes. Local validation alone cannot complete this work item; hosted execution waits
for authorization to push or dispatch. Cache misses must rebuild successfully.

#### T5 — Nx local adoption

The user selected Nx instead of the unrun Turborepo pilot on 2026-09-30. Local setup depends
on explicit ownership and conservative selection; it can proceed before the hosted Rust
cache decision. Hosted rollout remains dependent on CI proof.

1. Pin Nx core through pnpm. Retain the workspace layout and existing leaf commands; model
   package dependencies and explicit Cargo, provider and acceptance projects.
2. Cache JS/Electron builds and package typechecks with declared outputs, source/dependency
   inputs, lockfiles, Node/pnpm/platform identity and material environment. Keep all native
   and test-result evidence uncached. Use existing Cargo and reporting wrappers.
3. Verify the graph against Cargo metadata and cross-language consumers in the static gate.
   Exercise unchanged runs, package/Rust changes, fixtures, deleted outputs, material
   environment changes and upstream failure. Preserve `test:affected` fallback rules.
4. Validate current TypeScript 7, Electron Vite 6, Vitest 5, real-process protocol and desktop
   execution. Read official plugin requirements before adding any inference plugin.
5. Retain local Nx if bounded feedback evidence and dependency ordering justify it. Run the
   complete static gate after final changes. Hosted caching and distributed execution need
   their own compatible-machine, cost and evidence checks.

See [Nx commands](testing.md#nx-development-commands) and ticket 12. Neither a cache hit nor
partial acceptance replaces fresh complete proof. No remote cache or cloud workflow is
configured by local adoption.

#### T6 — Targeted accessibility scans

Depends on the stable browser/desktop fixtures and reporting from T2. Implements an additional
coverage work item alongside Phase 6; it does not claim an execution-speed gain.

1. Add `@axe-core/playwright` as a development dependency in the workspace that owns the
   Playwright desktop runner, using pnpm. Confirm compatibility with the installed Playwright.
2. Use the built desktop fixture to scan the shell, open command palette, and a representative
   confirmation dialog after each state is ready. Add conversation scans only when that
   production surface exists. Use fixture-supported setup and public UI interactions.
3. Scan once per representative state. Retain explicit keyboard, focus, and interaction tests.
   Attach rule IDs, affected elements, and actionable failure details to the standard report.
4. Fix newly exposed violations in the implementation phase. Any temporary exclusion must
   identify its exact scope, reason, and tracked issue; avoid a blanket ignore of current output.
5. Add the small deterministic scan suite to desktop acceptance and therefore CI. Report its
   execution cost separately so the expanded coverage is not mistaken for a regression in
   existing tests.

Complete when the scans pass on the real built surfaces and a temporary deliberate missing-label
defect is detected. Restore the deliberate defect before completing the work. Manual accessibility
and native-platform acceptance remain distinct requirements.

## Delivery and completion

Use this delivery order. The phases group responsibilities; this sequence interleaves their
tooling work so measurements precede optimization and correct CI coverage precedes caching.

| Order | Work | Required evidence before moving on |
|---:|---|---|
| 1 | Phase 1: suite ownership, provider coverage, discovery separation | Complete discovery and a passing local gate |
| 2 | Phase 2 + T1: reports and Hyperfine | Reproducible baseline and truthful failure summaries |
| 3 | Phase 2 + T2: test UIs and debugging | A diagnosed representative failure and retained evidence |
| 4 | Phase 3: local/CI coverage parity, before caching | Correct job membership; hosted run when authorized |
| 5 | Phase 4 + T3: focused selection and Bacon trial | Conservative selection tests and watcher keep/remove decision |
| 6 | Phase 3 + T4: CI caching trial | Total-time comparison, invalidation evidence, keep/remove decision |
| 7 | Phases 3–4 + T5: Nx local adoption | Task dependency/invalidation proof and keep/remove decision |
| 8 | Phase 5: measured timer, fixture, build, and concurrency improvements | Repeated before/after measurements with preserved assertions |
| 9 | Phase 6 + T6: performance/release evidence and accessibility scans | Separate performance results, explicit prerequisites, scan acceptance |

If hosted CI validation is awaiting authorization, record it as pending and continue independent
local work. Do not claim T4's hosted evidence from a local run. Each implementation step passes
`pnpm check:static` plus the suite it changes. Report each completed work item and its evidence.
Commit only when requested.

The overhaul is complete when:

- Maintained tests have explicit, validated suite ownership.
- Required local and CI gates enforce equivalent coverage.
- Deterministic provider tests are included and optional prerequisites remain explicit.
- Development selection is conservative, explainable, and tested.
- Correctness, performance, system, live, and artifact acceptance execute in their intended modes.
- Performance claims have reproducible before/after evidence.
- Existing acceptance requirements and process isolation survive the migration.
- Test READMEs and architecture verification guidance describe the implemented commands.
- T1–T6 have recorded completion evidence, including keep/remove decisions for optional trials.
- Added dependencies and tools are pinned appropriately, reproducible, and absent from runtime
  bundles unless the product itself requires them.

## References

### Implementation checkpoint — 2026-09-30

The local tickets are in `.scratch/testing-infrastructure/issues/`. Completion
means verified evidence, not merely an implemented command. Tickets 01–06,
08–10, 13–18, 20 and 21 have recorded completion. Ticket 17’s local worker
decision passed final static/ordinary acceptance. Ticket 19 has actual
packaged protocol/current-desktop proof, with eight legacy UI cases unexecuted
because their profile controls are unbuilt. The retained launch-refusal case now passes
against the same candidate after the renderer projects main’s profile error. Ticket 22's final ordinary acceptance
and inventory reconciliation passed; its outstanding proofs remain explicit. Ticket 07's hosted proof remains pending under
the user's instruction to keep working locally; 11 remains blocked by it. Ticket 12’s local Nx adoption passes its graph, cache, failure and stack checks independently of hosted rollout.

| Ticket | Outcome |
|---|---|
| 01 | Complete: all 107 deterministic provider cases belong to the static gate. |
| 02 | Complete: correctness, performance, package, live and system selections have explicit ownership/prerequisites. |
| 03 | Complete: native discovery rejects unowned tests and stale exclusions. |
| 04 | Complete: native reports, truthful aggregation and fixture phase evidence. |
| 05 | Complete: optional Hyperfine and recorded warm/fresh-target baselines. |
| 06 | Complete: one ordinary acceptance command with shared build prerequisites. |
| 07 | Local CI wiring verified; hosted provisioning, transport and execution pending. |
| 08 | Complete: conservative affected selection with explanation and broad fallback. |
| 09 | Complete: Vitest UI/HTML and bounded Electron failure evidence. |
| 10 | Complete: optional pinned Bacon retained for Rust feedback. |
| 11 | Pending: hosted cache timing/invalidation proof, blocked by 07. |
| 12 | Complete: Nx local adoption; 16-project graph, cache invalidation/output restoration, failure ordering and stack compatibility verified. Remote caching remains separate. |
| 13 | Complete: batched lint fixtures and journal initialization cleanup fix. |
| 14 | Complete: explicit debug timing policies; release/production boundaries verified. |
| 15 | Complete: fewer Git subprocesses with independently mutable scratch repositories. |
| 16 | Complete: browser configuration retained; order/isolation and launcher fixes verified. |
| 17 | Complete: bounded local protocol workers, two desktop workers, sharding omitted. |
| 18 | Complete: separate startup/stream/resync performance workloads and truthful metrics. |
| 19 | Partial: eleven current candidate cases and the retained launch-refusal case pass; eight legacy cases remain unexecuted because product UI is unbuilt. |
| 20 | Complete: installed/live/device/system infrastructure; external/product proofs remain explicitly pending. |
| 21 | Complete: targeted axe scans and keyboard acceptance; no full accessibility signoff. |
| 22 | Partial: ordinary acceptance/inventory audit and defined cold comparison verified; hosted/trial/full-package proof pending. |

Keep Hyperfine for explicit measurement, Vitest UI/HTML and bounded Electron
failure evidence for debugging, and optional Bacon for Rust feedback. Keep the
existing browser runner and isolation. Retain targeted axe scans; their evidence
does not establish complete accessibility conformance. Do not add sharding,
change paid capacity, or claim hosted CI cache results without their required
proof. Retain Nx core for local build/typecheck reuse and dependency ordering; test evidence remains uncached. Existing sccache behavior remains; no new hosted Rust caching trial is complete.

| Comparable measured work | Before | After | Scope |
|---|---:|---:|---|
| 84 lint-rule fixtures | Median 5.813 s | Median 1.427 s | Same assertions, batched runner |
| Five selected timing cases | Median 62.520 s | Median 23.819 s | Explicit debug clock policies; production defaults retained |
| Sixty repository fixtures | Median 94.529 ms/repo | Median 51.492 ms/repo | Isolated repositories; fewer Git subprocesses |
| 310 browser cases | 8.246/8.084/8.760 s | 7.979/8.071/10.964 s | No reliable speedup; keep configuration |
| Eight desktop cases, worker comparison | Median 13.431 s at one worker | Median 8.668 s at two | Supports existing two-worker default |
| Defined fresh-target backend build | 57.092 s | 33.718 s | One sample each; no reliable speedup claim |

These measurements cannot be summed into an overall gain. The original complete
aggregate baseline used three warm samples (801.537, 599.806, 611.565 seconds)
and a separately defined fresh-target backend build (57.092 seconds). Complete
protocol comparisons after the pnpm fix passed twice at five workers (489.000,
533.703 seconds); one three-worker sample passed and another exposed a signal
race. Failed samples are excluded, and protocol-only times are not compared
with full aggregate times. Added provider, fixture, browser, static, accessibility
and package coverage changes the inventory. The user requested an end to
restarted benchmark matrices; use existing controlled measurements and one
final acceptance gate. No final median or tail estimate is claimed from one run.

Required remaining proofs stay visible: hosted provisioning/transport/job
execution, hosted cache invalidation/costs, legacy
packaged UI, signed/notarized distribution and separately provisioned physical,
system and authenticated-provider requirements. The overhaul is not complete.

Local reference code inspected during the audit:

- Opencode `2c369a2`, 2026-09-23: `../ade-evaluation-2026-09-24/opencode-v2` from the repository root.
  Its `.github/workflows/test.yml` uses affected selection and bounded concurrency;
  `packages/app/e2e/performance/` separates serial benchmarks from correctness.
- T3code `e4eb9977`, 2026-09-23: `../ade-evaluation-2026-09-24/t3code` from the repository root.
  Its server configuration disables file parallelism; CI shards that suite across three runners.
  `SourceControlRateLimit.test.ts` demonstrates explicit-clock policy tests.

These repos inform the plan; their timings were not measured. Recheck current code and official
agent-facing documentation before implementing against any new dependency or API.

Primary guidance consulted:

- [Playwright fixtures](https://playwright.dev/docs/test-fixtures): explicit test and worker lifetimes.
- [Playwright sharding](https://playwright.dev/docs/test-sharding): distribution and report merging.
- [Playwright retries](https://playwright.dev/docs/test-retries): worker replacement and flaky results.
- [Vitest Browser Mode](https://vitest.dev/guide/browser/why): actual browser semantics.
- [Vitest profiling](https://vitest.dev/guide/profiling-test-performance): separating test execution from runner/import costs.
- [Testing Library principles](https://testing-library.com/docs/guiding-principles/): user-observable assertions.

Repository policy and acceptance remain authoritative:
[architecture](architecture.md), [protocol fixtures](../e2e/protocol/README.md),
[desktop E2E](../e2e/desktop/README.md), and
[shared reliability requirements](../.scratch/ade-v1/13-reliability/spec.md).

### Nx default command integration — 2026-09-30

Steps 1–4 are implemented locally: normal build/typecheck paths use Nx; protocol/desktop tasks declare build prerequisites and execute test-only commands; six independent repository checks run through the Nx scheduler with validated fresh reports; desktop production inputs exclude tests while typecheck inputs retain them. The static gate now has 23 top-level stages because six checks share one scheduling stage, with no coverage removed. Final static evidence: `static-e6ef3cc5-dd9e-4892-9f46-f00a696163f3`. Ticket 12 records cache-selection and focused acceptance evidence.
