# 17 — Tune workers and evaluate CI sharding

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-30)

**What to build:** Local and CI suites use worker counts supported by runtime and reliability evidence, with sharding only when its additional cost is justified.

**Blocked by:** [05 — Add repeatable benchmarks with Hyperfine](05-hyperfine-baseline.md); [07 — Make CI run the same acceptance gates as local development](07-ci-parity.md)

## Acceptance criteria

- [x] Compare bounded worker counts using representative and complete protocol runs; tune desktop separately and record failures, repeatability and whole-process-tree memory.
- [x] Keep diagnostic memory/profiling runs separate when instrumentation affects timing; document machine and cache conditions.
- [x] Select worker defaults from the measurements without increasing retries or weakening isolation.
- [x] Compare potential shard savings against provisioning, duplicate setup, transfer and runner costs; document a decision to omit sharding if unjustified.
- [x] If adopted, merge native reports and verify each selected test appears exactly once, with missing shard reports failing aggregation. Use nextest archives only if Rust execution is actually split; retain doctests separately.
- [x] Keep paid runner or capacity changes pending separate authorization and distinguish measured hosted evidence from local projections.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Before integrating a tool or dependency, check current official documentation and available agent guidance; pin compatible versions through the existing package manager or tool installer.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.


## Local comparison progress — 2026-09-30

Ticket 07's local CI wiring is implemented; hosted proof remains pending. The local comparison
uses an Apple M4 with 10 logical CPUs and 24 GiB RAM, Darwin 25.6.0. The current local protocol
default resolves to five workers; CI explicitly uses three and desktop defaults to two.

Three independent warm/existing-build samples at each of two, three and five protocol workers
passed the same 30-case inventory with zero skips or retries. Source stayed unchanged across
all nine samples. The selection covers boot, scheduler/lifecycle waits, real reconnects and
multibyte handling. Exact samples and native inventories are in
`test-results/ticket17-workers/representative-summary.json`. Two workers were slower; three and
five overlap enough that this subset alone cannot choose the default.

Next: compare three and five workers on repeated complete protocol runs, benchmark desktop
separately, and sample the entire observed process tree's RSS in separate diagnostic runs.
A sampled RSS sum is not unique physical memory or an exact instantaneous peak; short-lived
processes can fall between samples. No worker default or CI capacity/sharding setting has
changed. Ticket 17 remains incomplete; no hosted timings are claimed.

## Complete-run failure — 2026-09-30

The five-worker complete benchmark stopped on its second sample. Sample one passed
984 cases with five existing skips; sample two passed 983, skipped five, and failed the
installed pnpm/Bun/Yarn case because the daemon refused pnpm. Both used zero retries
and unchanged source. Retain `benchmark-dcb4cb66-1ddf-4df9-b6b3-3f6ae01b7a27`
and `test-results/ticket17-workers/complete-progress.json`; do not count the failed
sample as a timing comparison. A focused ten-copy diagnostic reproduced the same
pnpm refusal once (`protocol-be4c86f0-8d66-43bc-8f6c-3332da6b7825`).
Fresh standalone probes subsequently completed in 7–8 ms, so the cause remains
unverified. Candidate tracing is temporary; no deadline, retry, isolation or worker
default has changed. Complete three-worker, desktop and memory experiments remain
unexecuted.

The pnpm refusal is now reproduced without registry availability: the maintained
installed-tools case runs with `PNPM_CONFIG_OFFLINE=true`. pnpm 12 tries to resolve
metadata for its package-manager env lockfile even for `--version` in a fresh
project. ADE now sets `PNPM_CONFIG_PM_ON_FAIL=ignore` during pnpm version probes
and script launch; ADE still checks the installed version against the declaration.
The same case proves an unavailable pnpm declaration is refused. Removing only
the implementation reproduced the original refusal; restoring it passed. See
`test-results/ticket17-workers/pnpm-regression/verified.json`. The five-second
deadline and zero retries remain unchanged. Complete comparisons must restart
against this source; original failed samples remain separate.

The pnpm fix passed `pnpm check:static` (all 27 stages, 70.644 s) and
69 services/services2 cases with zero skips or retries. A preceding services run
concurrent with static checks failed the proxy listener-closure assertion; its
cause remains unverified. Five diagnostic copies and the uncontended services
run passed; no proxy fix is claimed. Temporary tracing and assertion diagnostics
are removed. Worker experiments now resume without concurrent checks/builds.

## Repeated full comparison and signal regression — 2026-09-30

The resumed source-frozen collection (`a50248638a1d7fc0f05ece97d27ca09f39d885e345148a293b0908e7b2eeee6d`,
1,547 files) passed both complete five-worker samples: 984 passes, five existing
skips, zero retries, 489.000 and 533.703 seconds by Hyperfine. Exact native inventories
and attempts match (`test-results/ticket17-workers/resumed/five-worker-audit.json`).
The first three-worker sample passed the same inventory in 649.849 seconds by the
native runner. Its second sample failed terminal attach (983 passes, one failure,
five skips, zero retries). Retain `benchmark-ed4c5adc-664d-4e6d-9b28-6c0f28d3aae4`;
the failed sample is excluded from successful timing comparisons. Source stayed
unchanged across both groups. A failed three-worker sample does not establish that
the worker count caused the failure.

A real CLI/PTY regression reproduces the exact expected-130/received-minus-2 failure
by signaling as raw mode becomes observable. A test-only Node preload pauses after
the real raw-mode transition. The CLI now registers SIGINT/SIGTERM/SIGHUP handlers
before enabling raw mode; no production delay was added. Removing only that change
reproduced the same assertion, and restoration passed. The ordinary probe now uses
a fresh marker assembled by shell output, so neither replay nor echoed input can
satisfy its freshness check. An initial long echoed marker broke at readline wrapping;
that failed attempt remains in the evidence. Three maintained CLI cases passed,
and both attach scenarios passed ten diagnostic copies each. Repeated copies are
not counted as aggregate acceptance. Proof is in
`test-results/ticket17-workers/attach-regression/initial-proof.json`.

Static validation of this latest change, desktop comparison, separate memory samples
and the final worker decision remain pending. Ticket 17 is still incomplete.

## Stop repeated complete comparisons — 2026-09-30

The user requested faster completion after twelve hours. Keep the existing complete
and representative samples; do not restart the full worker matrix after each fix.
Use focused correctness checks for fixes and one final acceptance gate after the
remaining local changes. Desktop and memory evidence remain pending; hosted costs
remain unmeasured. No speed claim uses failed samples.

The latest static run (`static-0f5f5045-7d8b-43e0-ab8e-b89bfb8d99cf`) failed the
controller descendant test: its marker existed with empty contents because the
shell created the file before writing it. The fixture now writes a temporary marker
and renames it after the write. All four `ade-platform` process tests passed using
`node scripts/cargo.mjs test -p ade-platform process::tests -- --nocapture`.
The full static gate remains pending for the final acceptance run.

## Local worker decision — 2026-09-30

All six desktop timing samples passed the same eight cases, once each, with no
skips or retries. One worker: 13.813, 13.330, 13.431 seconds (median 13.431).
Two workers: 8.668, 8.685, 8.561 seconds (median 8.668). Retain two desktop
workers. Benchmarks are `benchmark-857eda4c-d32f-4dd4-8483-721ad98f0931` and
`benchmark-3630e8c5-e0f3-4507-ac10-2f919575c71a`.

Four separate memory diagnostics passed: all eight desktop cases at one/two
workers and the same 30 representative protocol cases at three/five workers.
Peak sampled process-tree RSS sums were respectively 1,668,864; 2,823,072;
2,484,160; and 3,862,688 KiB. This is sampled summed RSS, not unique physical
memory or an instantaneous peak. Shared pages and missed short-lived processes
limit the result. Diagnostic elapsed times do not enter clean timing comparisons.
Raw samples, observer source, native inventories and the independent inventory
audit are in `test-results/ticket17-workers/final-local/decision.json`.

Keep five local protocol workers on this ten-CPU machine and cap automatic
selection at five on larger hosts. Explicit overrides remain available. Keep
CI's existing three-worker setting pending hosted evidence. No retries, test
isolation, deadline or paid capacity changed. Source stayed unchanged across
the earlier complete protocol comparison; failed samples remain excluded.

Omit sharding. Ideal two-way splitting of the 650-second local three-worker
sample projects at most about 325 seconds saved before additional overhead.
Hosted provisioning, duplicate setup, transfers, queueing and billing remain
unmeasured, so that projection cannot justify the extra jobs. Rust is not split,
so no nextest archive/report merging is introduced. The existing report merger
already fails missing/duplicate shard evidence; no new shard execution is claimed.

The protocol configuration passed its native Playwright discovery check. Final
static and complete ordinary acceptance validation remain pending. No new complete
worker benchmark matrix is planned.

## Final validation — 2026-09-30

`acceptance-d739f308-a6e3-444e-92c2-6bcb37caa058` passed the complete ordinary
gate in 587.804 seconds: static's 27 stages passed in 70.316 seconds, backend
build passed, protocol passed 985 cases with the same five existing skips in
500.343 seconds, and desktop passed all eight cases in 11.220 seconds. Every
executed protocol/desktop case ran once; no correctness retries or new skips.
The native inventory audit removes line-number changes before comparison and
finds no removed baseline case or changed outcome. Six protocol cases and one
desktop case were added. The terminal signal regression and installed-tools
case both pass in complete acceptance. Evidence is in
`test-results/ticket22-verification/final-acceptance-audit.json` and
`test-results/ticket17-workers/final-local/decision.json`.

This closes the local worker/sharding decision. It does not close ticket 07's
hosted proof or establish hosted runner costs. No commit, push or paid capacity
change occurred.
