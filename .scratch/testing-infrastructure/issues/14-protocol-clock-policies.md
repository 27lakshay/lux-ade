# 14 — Shorten protocol waits through explicit clock policies

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-30)

**What to build:** Receipt-pruning and plugin-timer acceptance completes sooner while still proving the real daemon/runtime scheduler wiring.

**Blocked by:** [05 — Add repeatable benchmarks with Hyperfine](05-hyperfine-baseline.md)

## Acceptance criteria

- [x] Measure the long receipt, plugin deadline and debounce cases and identify the narrow timing-policy seams before changing behavior.
- [x] Use an explicit clock for deterministic due-time and boundary decisions; preserve real-process acceptance for scheduler activation, lifecycle, persistence and recovery.
- [x] Where required, provide bounded test-only intervals with validation. Verify production defaults and release safeguards against accidentally enabling test controls.
- [x] Preserve existing assertions and cleanup; do not replace real process acceptance with only mocked timing tests or sleeps that race readiness.
- [x] Run focused clock-boundary and process acceptance tests plus the complete affected protocol coverage. Compare repeated same-case timings and reject changes that add instability.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Investigation progress — 2026-09-29

The before benchmark is **failed**, not a performance baseline. Source remained unchanged
(SHA-256 `979ef998db47dc43dcc22f714cb49dbb5dd27b9d810abbaa29ff0c7c39de11f3`).
`test-results/ticket14-before.json` records the command and source verification.
`benchmark-6c4c991a-f169-454d-a587-0d3bfa1e81f0` retains native reports: the first
five-case sample passed; the second failed the continuous-source reload case with
`outcome_unknown` after SIGKILL while an echo command was open. Other selected cases
passed. No timing-policy changes have been made.

The failed profile's persisted receipts show three completed generation-2 echoes,
then `plugin-dev-60189-4` admitted at 1790691892653 ms. Generation 3 committed at
1790691892654 ms; the fourth receipt became unknown at 1790691892708 ms. Lifecycle
evidence shows generation 2 deactivating and generation 3 activating. The final
assertion polls effectful echo commands while reload is in progress. Command admission
versus draining remains an unresolved hypothesis, not a proven root cause.

Two unchanged-source focused runs used native JSON reporting and `--repeat-each 10`
and `--repeat-each 30`, with five workers and no correctness retries. All 40 independent
copies passed; these do not erase the original failure. Native results are retained in
`test-results/ticket14-diagnosis/`. Next: pin the admission/drain overlap, distinguish
test readiness from host lifecycle behavior, and resolve it before collecting a new
comparable timing baseline. Ticket 14 remains incomplete.


## Admission correction and second baseline failure — 2026-09-29

The host lookup fence did not cover callers already holding `Arc<HostProcess>`. Those callers
could register new work after retirement, after draining had observed zero open calls.
Retirement now closes admission under the same pending mutex used to register calls. Lifecycle
`deactivate` remains allowed. Calls registered before retirement keep the existing drain grace;
timeouts, production defaults and unknown outcomes for genuinely dispatched work are unchanged.

Two maintained public-protocol regressions hold a real invocation after lookup and durable
receipt dispatch, retire it by disable or reload, and freeze the real plugin in deactivate.
The existing debug-only bounded receipt handshake controls the ordering; no replies are
simulated. The test checks `not_applied`, no extra handler effects, process exit and receipt replay
after a new generation becomes active. The initial event-loop probe failed with
`outcome_unknown`: protocol-e66f51ff-4e6d-41ae-bb33-0b0e7d785ec0. Removing only the admission
check made both cases fail: protocol-780b4f62-ed43-46f3-a5d6-0d057ff768a3. Restoring it passed
both: protocol-c07fb683-2104-4a2f-b009-af9439df6383. An earlier SIGSTOP probe passed without the
fix because the host exited before registration; it was rejected as regression proof.

Complete affected protocol selection passed **56 cases across 18 files**, with no skips or retries,
in 68.387s: protocol-65cc7357-c334-43c7-ab32-a20463eb9fc0. This includes plugin drain, hooks,
crash/recovery, leases, secrets, backup and profile isolation. `pnpm check:static` passed all
**27 stages in 68.220s**: static-407fd4e2-ab7e-432f-9c8a-dd398d31769c.

A new same-five-case, five-worker timing benchmark failed before collecting three successful
samples: benchmark-1a3193d8-b5aa-4054-b831-7292c3481244. Four cases passed. The continuous
source case failed a different assertion: its activated version and final written version were
both `w68`, while the test expected them to differ. The retained database and lifecycle record
confirm generation 2 activated `w68`. This is not an unknown-outcome failure. Source stayed
unchanged throughout the run (SHA-256
`77491e22591322bcb7d411c88c3eb61128750e6dc99eb9075f4d44ba51464370`, 1546 files).
Do not treat this run as a performance baseline.

The deterministic timing decisions already accept explicit timestamps (`prune_due`,
`Debounce.observe`, `drain_step`). The remaining seams are their scheduler and lifecycle waits.
Next: make the retuned-debounce setup establish an explicit pending source change, preserve its
version assertions, and query the committed generation before its final echo. Then collect a
successful baseline before bounded interval changes and release safeguards. No timing policies
have changed. `test-results/ticket14-admission/verified.json` retains all evidence. No daemon or
runtime processes from this worktree remained after validation. Ticket 14 remains incomplete.

## Continuous writer handshake and timing preset — 2026-09-30

The fixture now waits for the live writer to complete a write after observing the immutable
artifact commit. It preserves the original partial-versus-final version assertion. Removing
only this handshake failed all five diagnostic copies at that original assertion (`w68`);
restoring it passed. A prior manual edit after the partial read was rejected because its
removal did not reproduce the failure. Its reports remain in the evidence directory.

The final corrected fixture passed three same-five-case samples: 62.313, 62.520 and 62.547 s,
median 62.520 s. Source remained unchanged. All five cases passed in each sample with zero
skips or retries. Static validation passed all 27 stages in
`static-dc158435-0ca1-4667-a101-e1f82d87602b`. An earlier browser import failure remains
unexplained: `static-897d59b3-3569-4b2c-950d-1bf7df985bca`; five observed fresh browser runs
passed without HTTP failure events, and the temporary observer was removed.

A fixed explicit debug preset now shortens receipt first-run/tick and plugin activation,
deactivate and drain intervals. Production defaults, recurrence and retention, invoke timeout,
health probes, watcher cadence and the real 10-second debounce cap remain unchanged. Due-time
and drain decisions continue to receive explicit timestamps. The preset passed the five
focused process cases. Release binary refusal, complete affected coverage, final static
validation and an uncontended repeated timing comparison are still pending. Ticket 14 remains
incomplete. `test-results/ticket14-debounce/verified.json` records the final handshake evidence.


## Final verification — 2026-09-30

The fixed debug timing preset is adopted. No new package or scheduler framework was needed.
Pure receipt due-time, debounce and drain decisions use explicit timestamps; the real scheduler,
plugin hosts, persistence, retirement and replay remain in protocol acceptance. Only four
selected cases opt in; ordinary profiles retain production defaults. The continuous writer case
keeps its real 10-second debounce cap and the verified writer handshake.

The locally built release daemon refused `short`, empty and invalid controls. Debug daemons
refused empty and invalid controls. All five refusal probes exited before stores, a socket or
runtime ownership were created. Pure tests verify production defaults and the bounded parser.
The first static run caught constant assertions in the new tests; the final tests assert the
parser output and pass Clippy.

Complete affected acceptance passed **76 cases with zero skips or retries in 79.985 s**:
`protocol-f7fb9271-6736-49e5-ad68-ca7e40962870`. Final `pnpm check:static` passed all **27 stages
in 73.426 s**: `static-a5778975-a68d-407a-ae94-fa7753cd56ef`, including the clock boundaries,
production defaults, preset validation and all 311 browser cases.

The final uncontended same-five-case benchmark passed every case in all three samples:
`benchmark-eb2f7260-5e7c-4f5e-8c8e-c6d99480729c`. Exact before/after samples, source hashes,
native reports, release refusal and prior failures are in `test-results/ticket14-timing/verified.json`.
Median time fell from **62.520 s to 23.819 s (61.9%)** for this selection. Hyperfine flagged the
first after sample as slower; all samples and the warning remain. A separate successful run
that overlapped release compilation is retained as diagnostic evidence and excluded from the
comparison. No whole-suite improvement is claimed. No owned daemon/runtime remained.

All Ticket 14 acceptance criteria are complete. Hosted CI, signing and packaged release proof
remain separate pending work. No changes were committed or pushed.
