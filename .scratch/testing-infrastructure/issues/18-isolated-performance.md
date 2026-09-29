# 18 — Establish an isolated performance suite

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Contributors can measure controlled application workloads separately from correctness and inspect reproducible raw samples.

**Blocked by:** [02 — Separate correctness, load, package and environment-dependent suites](02-suite-selection.md); [05 — Add repeatable benchmarks with Hyperfine](05-hyperfine-baseline.md)

## Acceptance criteria

- [x] Run the existing load workload alone with one worker through `pnpm test:performance`; record whether the binaries are debug or release builds.
- [x] Add explicit startup and terminal streaming/resync workloads for implemented surfaces, with readiness criteria, input sizes, sample counts and failures. Record unavailable surface coverage as deferred rather than building product features in this ticket.
- [x] Capture memory in separate diagnostic runs when measurement changes execution; keep tracing and forced-GC diagnostics distinct from clean latency results.
- [x] Preserve raw samples and machine/revision/configuration metadata, including failure samples. Label synthetic conversation workloads as synthetic until the production surface exists.
- [x] Keep provisional thresholds identified as provisional; do not derive app latency budgets from correctness-suite duration.
- [x] Demonstrate that ordinary correctness commands cannot launch these workloads and document repeatable selected-workload invocations.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Existing workload baseline

Explicit `pnpm build:backend` followed by `pnpm test:performance --workers 1` passed.
The build command produces debug binaries; SHA-256 values, command exits, machine,
revision and unchanged source identity are in `test-results/ticket18-existing-load/evidence.json`.
The source was unchanged throughout. The run used one worker and no retries:
`performance-c66d22c4-c271-4227-9cc7-7d621040d459`. Native inventory independently
verified one passed case. Runner wall time was 10.3 s; outer command time 10.649 s.
The original attached summary is extracted to `test-results/ticket18-existing-load/load-results.json`.

The existing test passes, but its reporting does not satisfy this ticket yet: it attaches
results only near the end, reduces successful samples to percentiles, loses failed-call
latency, and does not identify the build mode in the result. Cleanup for extra clients
and browser-owner resources is reached only on success. It records diagnostic memory/CPU
alongside latency rather than offering a separately labelled diagnostic run. Startup and
controlled streaming/resync measurements are still missing. These are implementation
work, not missing external prerequisites; Ticket 18 remains incomplete.

### 2026-09-29 — Workloads and raw evidence implemented

`pnpm test:performance` now builds the debug backend, SDK and CLI, then runs one worker
with zero retries. The wrapper pins the Cargo output directory used by fixtures, clears
an inherited cross target, retains effective development-build flags, and limits filters
to @load. Native global setup also rejects extra workers and retries. --list uses the
native listing reporter and never builds; its first implementation incorrectly required
execution evidence after listing, so that failure was retained and a permanent CLI
regression added.

Each workload attaches raw JSON and append-only JSONL, including failed durations,
earlier samples and unfinished operations. Metadata names the actual worker count,
configuration, executable hashes, revision/dirty state, machine, readiness criteria and
input sizes. No dependencies were added. Node main-thread recording happens outside timed
intervals but adds overhead between operations; these measurements are not instrumentation-free.

The original load keeps its workload and assertions. Command/echo/history/recovery samples
are retained individually. Empty summaries have null percentiles. Diagnostic mode keeps
resource and bounded-queue checks, with raw process-resource observations at four checkpoints.
Cleanup callbacks now run after failures too. New workloads use five fresh startup profiles
and three 360,000-line terminal floods with throttled SDK/TerminalFeed/Ghostty viewers.
The shared viewer helper was extracted from the existing resync tests without dropping
assertions. All five executable correctness cases passed in
`protocol-e4eeeff2-78c0-46df-800a-fbde65b5ce22`; its known slow-TTY replay gap remains skipped.

Final latency run: `performance-command-0590f9b0-6341-4cf3-b1e2-a93a3ebf16a5`,
three passed in 35.249 s runner time. Final diagnostic run:
`performance-command-be28f662-033f-4c58-a625-635f6c3e1d6d`, three passed in 36.913 s.
`test-results/ticket18-verified.json` independently matches native reports to raw samples:
25 startup observations, 12 streaming observations, 933 load observations in latency mode;
25 / 12 / 1039 in diagnostic mode. Load sample counts vary with its documented sustained
completion condition. Diagnostic resource snapshots number 5 / 3 / 4 respectively.
These modes are not pooled and no before/after speedup is claimed.

Startup ready observations: 192.90, 192.50, 193.18, 191.80, 193.34 ms (median 192.90 ms).
First-resync observations: 7160.21, 7162.27, 7149.63 ms; released catch-up: 24.33, 23.42,
23.50 ms. They include fixture/readiness or polling costs as documented. The full new
suite has broader scope than the original single load case. Admission/echo targets remain
provisional. Electron rendering, real model latency and the known TTY product gap are
explicitly outside the verified measurements.

Three injected failures prove retained setup/SDK/assertion evidence and process cleanup:
`test-results/ticket18-failure-probes/verified.json`. Cancellation returned 130, retained
an incomplete operation and stopped owned processes while an unrelated sentinel survived:
`test-results/ticket18-interruption-fixed/evidence.json`. Temporary probe source is archived
in the failure directory and removed from discovery.

### 2026-09-29 — macOS cancellation regression found by final static gate

The first static checkpoint passed (`static-df9ea97f-bad3-4b2c-b106-f7436646f96c`).
A later final run failed its provider-cancellation test with EPERM when probing an exited
process group. A new real-process regression deterministically reproduces the same error
with a group containing only an unreaped zombie. The shared runner now checks the process
table for this macOS condition and accepts only an empty or zombie-only group; live groups
and failed process-table reads retain the error. Observed red, green, remove-only-fix red,
and restored green. Evidence: `test-results/ticket18-cancellation-regression/`.
The regression is macOS-specific; other platforms retain their existing behavior.
The actual performance cancellation probe also passed after this fix.

Official references checked: [Playwright fixtures](https://playwright.dev/docs/test-fixtures),
[attachments](https://playwright.dev/docs/api/class-testinfo#test-info-attach),
[available test-agent guidance](https://playwright.dev/docs/test-agents), and
[Apple's process-group signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c).
No agent tooling was installed or invoked. Final static validation remains pending.

### 2026-09-29 — Completed

Final `pnpm check:static` passed all 25 stages: `static-7439ac10-d7a1-403c-9424-32377e1aa13e`.
This includes 301 JavaScript cases, the actual listing regression, native suite partition
checks, browser/provider checks and Rust tests. The earlier failed static run is retained
as `static-040b17d6-0887-4aac-99ec-303d35b15ca9`, not counted as passing evidence.
`git diff --check` passed. All temporary failure probes are outside discovery.

The implementation and validation satisfy this ticket's local scope. Release-build timing
and the explicitly documented product-surface gaps remain unclaimed; hosted CI is still
pending under Ticket 07.
