# 16 — Reduce browser test setup costs

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** The browser suite avoids demonstrated startup or import waste while preserving real browser semantics for behavior that depends on them.

**Blocked by:** [05 — Add repeatable benchmarks with Hyperfine](05-hyperfine-baseline.md)

## Acceptance criteria

- [x] Profile runner, worker, import and setup overhead before selecting an optimization; record a no-change decision if no worthwhile bottleneck exists.
- [x] Move a test to an in-process Node runner only when its subject is genuinely browser-independent, preserving discoverability and assertions.
- [x] Keep CSS, geometry, focus, canvas and WASM behavior in Chromium. Do not disable isolation globally to claim a speedup.
- [x] Use Vitest doctor only for configuration candidates that apply to the actual project type; Node pool/module-cache options do not constitute browser optimization evidence.
- [x] Repeat equivalent before/after runs, check order independence and preserve surrounding browser interaction coverage. Retain only useful, stable changes.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Before integrating a tool or dependency, check current official documentation and available agent guidance; pin compatible versions through the existing package manager or tool installer.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Profile and launcher regression

The first browser benchmark failed before executing tests: the benchmark passes
`--maxWorkers` explicitly while the launcher also supplies it from `ADE_TEST_WORKERS`.
Vitest rejects duplicate values. Retained failed run:
`benchmark-f31423c9-239e-433d-975c-fb91fdad9204`. The launcher now lets an explicit
CLI worker value override the environment default, in both supported CLI spellings.
Three permanent tests validate the forwarded arguments with the actual installed
Vitest CLI. Observed red, green, remove-only-fix red and restored green; logs are in
`test-results/ticket16-profile/ade-ticket16-worker-*.log`.

Fresh valid baseline: `benchmark-1dd13624-548e-4bae-9c47-5d88378b7f23`, five workers,
three runs, warm cache, no warmups. Command times: 8.246, 8.084, 8.760 s. Each ran
all 42 files / 310 cases. Source immutability is recorded in
`test-results/ticket16-browser-valid-baseline.json`.

Profiling used the installed Vitest 5.0.2 main-thread CPU profiler and a temporary
reporter reading public module/test diagnostics. Raw CPU profile, module diagnostics,
reporter source, native JSON and logs are retained in `test-results/ticket16-profile/`.
Both profile runs passed all 310 cases; the diagnostic run records zero retries and
repeats. Node main-thread CPU samples include 3.867 s idle and 114 ms self time in
Rolldown transformSync. These samples exclude Chromium CPU and are not clean wall-time
benchmarks. There are no configured setupFiles/globalSetup; reported setup durations
are zero. All browser importDurations maps are empty despite enabling collection,
so this version did not provide per-import evidence for this project.

Do not interpret the displayed 88–89% worker share as avoidable startup. The installed
browser tester calculates prepareDuration from `now - startTime`, then subtracts that
duration from `now` again; the resulting module values track elapsed time. The 42
reported preparation durations sum to 241 s in a 7.24 s run. Parallel timing sums
are not wall time, and this arithmetic makes attribution especially unreliable.
Collection totals overlap too: 6.034 s across files, while tests/hooks total 25.372 s.
The longest modules exercise terminal recovery, pointer dragging and pane interaction;
the recovery assertion deliberately observes four product attachment attempts.

Provisional decision: keep the browser configuration and all browser subjects in place.
`when.ts` and `navigator-tree.ts` are pure candidates, but their test bodies total about
2 ms and no stable critical-path saving from a second runner has been demonstrated.
Shortcut and key-code modules also own navigator/browser behavior; layout vectors use
Vite's import.meta.glob. CSS, geometry, focus, canvas and WASM stay in Chromium with
isolation enabled. Installed doctor candidate selection excludes Node pool/environment/
module-cache candidates from browser projects; its applicable no-isolate candidate
violates this ticket, so no doctor campaign was run. No dependency was added.

Official guidance checked: [profiling](https://vitest.dev/guide/profiling-test-performance),
[performance](https://vitest.dev/guide/improving-performance), the
[agent documentation index](https://vitest.dev/llms.txt), and
[browser interaction state](https://vitest.dev/api/browser/interactivity).

### 2026-09-29 — Shuffled execution exposed fixture state

The full suite at seed 20260929 failed two cases, retained under
`test-results/ticket16-order/20260929`: a terminal fixture counter was shared between
tests, and a pointer left by an earlier ProjectTree case opened a tooltip over the
next case's click target. The same two failures reproduced in a focused 22-case run
(`test-results/ticket16-order-targeted-red`). The terminal counter now belongs to each
host fixture. ProjectTree explicitly resets pointer position before its new window,
using Vitest's documented unhover operation. All original assertions and real pointer
clicks remain. Focused shuffled green passed all 22 cases. Final regression verification,
full shuffled runs, repeated final timings and static checks remain pending.

### 2026-09-29 — Completed with no browser configuration change

Removing only the two fixture fixes reproduced the same two assertion/action failures
in `test-results/ticket16-order-remove-fix-red`. After restoration, complete shuffled
runs at seeds 20260929 and 73 each passed all 310 cases. Existing recovery, geometry,
focus, canvas and WASM cases remain in the native inventory.

| Equivalent five-worker browser command | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Before fixture isolation fixes | 8.246 s | 8.084 s | 8.760 s |
| Final | 7.979 s | 8.071 s | 10.964 s |

Final benchmark: `benchmark-19118ae9-ec5e-4602-9105-9ffb87d32364`. Raw timings and
source identities are retained; `test-results/ticket16-verified-comparison.json`
independently verifies identical 310-case inventories across six ordinary and two
shuffled runs. Hyperfine flagged variation in the final samples. No speedup is claimed.
All runs use zero configured correctness retries; the diagnostic run independently
records every test's retry/repeat count as zero. No tests were moved to Node and no
assertions were removed.

**Keep:** explicit CLI worker precedence, per-host terminal fixture counter and pointer
reset for ProjectTree. **No change:** browser configuration, dependencies, isolation,
renderer import graph and runner assignment. The evidence does not justify additional
performance complexity. `docs/testing.md` documents worker precedence and reproducible
order checks. Final `pnpm check:static` passed all 25 stages:
`static-8c032067-1d45-4313-9e0c-4647a2d36499`. JavaScript now includes three additional
launcher regression cases; the 310 browser cases are unchanged.
