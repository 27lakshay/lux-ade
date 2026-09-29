# 15 — Reduce measured protocol fixture overhead

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Protocol setup or teardown becomes cheaper at its demonstrated bottleneck without sharing mutable test resources.

**Blocked by:** [05 — Add repeatable benchmarks with Hyperfine](05-hyperfine-baseline.md)

## Acceptance criteria

- [x] Use recorded fixture phase timings to identify whether repository setup, process-table scans or another fixture cost warrants work; document a no-change result if it does not.
- [x] Optimize one demonstrated cost at a time; reuse only immutable binaries, bundles or prepared inputs where isolation remains verifiable.
- [x] Retain separate homes, profiles, databases, repositories and sockets, process identity checks and failure on leaked owned processes.
- [x] Verify normal completion, startup failure, test failure and cancellation all clean up owned processes without affecting unrelated processes.
- [x] Compare repeated representative and full-suite runs with unchanged assertions; revert if cleanup reliability or maintenance cost outweighs the saving.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Repository template experiment; validation in progress

Successful Ticket 05 full-suite reports each contain 476 repository creations. Their
median creation times were 420.8, 307.0 and 295.3 ms. Phase durations overlap; they
are not additive wall time. `test-results/ticket15-baseline-phases.json` retains the
source reports and summaries.

The fixture now uses Git's immutable template config for its existing local identity
and disabled signing settings. This removes three Git subprocesses per repository
(seven to four). Git still initializes independent repositories; the template has no
objects, index, refs, hooks or writable shared state. Git validated the config with
`git config --file e2e/protocol/fixtures/git-template/config --list`.

Fresh boot measurements ran the same 20 cases three times, five workers, existing
binaries, zero warmups/retries. Before: 17.520, 16.393, 16.825 s; after: 26.242,
18.432, 16.565 s. **This does not prove a suite speedup.** Only two repositories
were created per sample. Full metadata and identical case inventories are in
`test-results/ticket15-boot-comparison.json`.

A direct workload created 20 isolated repositories per run, three runs per variant,
one worker, identical assertions. Median repository setup over 60 creations fell
from 94.53 to 51.09 ms. Median workload wall time fell from 3.664 to 2.384 s.
`test-results/ticket15-repository-comparison.json` retains raw durations and source
identities. The temporary workload source is archived in test-results and removed
from test discovery. Keep the template provisionally, pending the remaining checks.

The initial Git-heavy before sample failed before implementation. The merge-abort
receipt reports `.git/index.lock` contention; the test was polling ordinary Git status.
`benchmark-2a91236d-b643-4806-a5f6-86272cd59955` retains this failure.
`ScratchRepo.status()` now uses `--no-optional-locks`, matching Git's recommendation
for background status. A permanent regression touches an unchanged file and checks
that both clean and dirty status reads preserve the index bytes. Observed red
`protocol-867313b7-bb38-4450-b921-fa1081218deb`, green
`protocol-a4751d5c-566c-4a1b-abcc-f87b4680bbcf`, remove-only-fix red
`protocol-e11c64b9-7884-4d75-a5bc-ca4e84f74c56`, restored with 18 Git/isolation
cases passing in `protocol-77c3b72a-30e3-46f0-b31d-3a696f0c59db`. The regression
proves status no longer writes the index; it does not prove every possible source
of Git lock contention is eliminated.

The permanent isolation case verifies distinct config inodes, independent local
settings, branches, index contents and commit objects, no object alternates, and an
unchanged template. The first static run passed all 25 stages before the status fix
(`static-0107a6ca-b805-46ee-88ce-f93488e58fc4`). Final static validation, cleanup
failure/cancellation probes and repeated full-suite validation remain required.
Ticket 15 is incomplete. Ticket 14's separate plugin reload failure remains open.

Sources: [Git templates](https://git-scm.com/docs/git-init#_template_directory) and
[background status](https://git-scm.com/docs/git-status#_background_refresh). No new
package was added. No official Git agent skill or MCP was found in the targeted search.

Final static validation passed all 25 stages: `static-400009ff-159d-486c-81c9-3f2f7c89641b`. `git diff --check`
also passed. Cleanup-path and full-suite proof remain pending.

### 2026-09-29 — Cleanup probes and cancellation fix

Normal completion, daemon startup failure and deliberate test failure cleaned up all
owned processes and left an unrelated sentinel alive. Cancellation initially leaked
the detached runtime and its shell: `test-results/ticket15-cleanup/cancel/` retains
the recorded identities and failure. Those exact test-owned processes were stopped
after recording the evidence.

The shared process wrapper sent SIGKILL to the entire group as soon as the package
manager launcher exited. Its runner descendants were still doing fixture teardown.
It now waits for that group to finish within the existing five-second cancellation
bound before force-killing survivors. A real-process regression creates a launcher,
a runner and a detached resource; it proves the runner can clean up that resource
after the launcher exits. Observed red, green, remove-only-fix red, then restored;
logs: `/tmp/ade-ticket15-cancellation-{red,green,remove-fix-red}.log`.

All four probes passed after the fix, with no owned survivors and the unrelated
sentinel still alive: `test-results/ticket15-cleanup-fixed/evidence.json`. Cancellation
returned 130 and produced an interrupted native report. A process ignoring SIGINT
was force-stopped after 5004 ms;
`test-results/ticket15-cancellation-bound/evidence.json` records the bound. Temporary
failure probes were removed from discovery; their source is retained with evidence.

An initial static run rejected an explicit throw inside the regression's finally
block; cleanup now asserts the expected ESRCH result. Final static validation passed
all 25 stages: `static-f634db9f-eb76-4864-abdd-3e1efcba4095`. Repeated full-suite validation remains pending.

### 2026-09-29 — Preserve hook and exclusion directories

The first full after run (`benchmark-e4e50a8e-03c5-47aa-93b7-f271fb454615`)
finished 979 passed, 2 failed, 5 skipped in 406.276 s. Both failures were regressions
from the minimal template: CLI tests could not write `.git/hooks/pre-commit` because
the hooks directory was missing. This failed sample is retained and is **not** a
successful performance result. Source immutability was verified.

The fixture now creates private `.git/hooks` and `.git/info` directories after init.
The existing isolation test asserts both are present. Observed assertion red
`protocol-e7ae2b3e-1d63-4729-8538-fd7c846de583`; all nine isolation, CLI Git and
checkpoint cases green `protocol-b19c2baa-d824-4858-8141-f421cc9c9c4c`; remove-only-fix
red; restored isolation cases green `protocol-c89acc6d-af3b-4579-9d80-db94e167b07f`.

The final fixture was measured again over 60 creations: median setup 51.49 ms
(original 94.53 ms); 20-repository workload times 2.757, 2.352, 2.473 s. Raw results
and source metadata: `test-results/ticket15-repository-final-summary.json`. The
status read also now avoids optional locks, so the workload wall-time comparison
includes that correctness fix; the creation phase excludes those later status reads.
Final static validation passed all 25 stages in `static-80a11573-03bb-4eab-8660-8df77e01deb3`. A new three-run full
protocol collection is required; Ticket 15 remains incomplete.

### 2026-09-29 — Complete full-suite collection and keep decision

The corrected three-run collection passed: `benchmark-33e5ac43-5114-4a91-b1f4-57ab0c93a4dc`.
The independent audit (`test-results/ticket15-full-verified.json`) checks native
Playwright results, all original case identities/verdicts, added cases, zero retries,
Hyperfine exits and unchanged source SHA-256
`e733eb24958ab05af2f6367260115fd3a9b56247651f25d013d7a15b4ff20ee1` across 1519 files.
Each run passed 981 cases and retained the same five skips. All 984 original cases
remain; the two new fixture regressions pass.

| Measurement | Before | Final after | Interpretation |
| --- | --- | --- | --- |
| Direct repository creation, 60 samples per variant | Median 94.53 ms | Median 51.49 ms | About 45.5% lower setup time |
| Fresh 20-case boot sample, 3 runs | 17.520 / 16.393 / 16.825 s | 16.447 / 16.186 / 16.307 s | Small difference; three samples do not establish a stable suite gain |
| Full protocol native wall time, 3 runs | 681.040 / 521.242 / 515.687 s | 444.562 / 475.753 / 535.795 s | Broad characterization, not isolated attribution |
| Full-suite repository creation medians | 420.76 / 306.99 / 295.35 ms | 168.92 / 166.11 / 214.95 ms | Setup remains lower under the full workload |

Final full command times were 445.017 / 476.299 / 536.210 s (median 476.299 s).
The earlier protocol runs followed static checks and builds inside full acceptance;
the final protocol runs ran alone. This ordering difference, the two added cases and
the large range prevent attributing the whole wall-time difference to the template.
The focused creation phases are the direct evidence for retaining it. No latency
percentile or product budget is inferred from three suite runs.

**Keep:** the Git template, private hook/exclusion directories, read-only status
polling and graceful cancellation fix. They remove three repository-setup subprocesses,
retain independent mutable resources, and repair observed lock contention and cleanup
failures. The failed template and cancellation probes remain in the evidence record.
No new package or shared mutable repository cache was introduced.

All seven desktop acceptance cases also passed with native inventory verification
and zero retries: `desktop-738ae516-36e2-4513-89bc-43d5e2b37f21` (10.2 s runner
summary). This covers the desktop's reuse of the same protocol fixtures.
`docs/testing.md` now explains the template, read-only status and cancellation behavior.

### 2026-09-29 — Final verification

Final static checks passed all 25 stages in `static-a60f39b6-f1df-48ce-a224-39a0ee10034a`. The finished fixture passed three fresh boot samples with identical 20-case native inventories and zero retries: `benchmark-0a205c01-acf6-4f49-958b-4bab9cbb5b0f`. Command times were 16.447, 16.186 and 16.307 s; source remained unchanged across all runs. The earlier slower boot experiment remains recorded above. `test-results/ticket15-final-verification.json` retains the comparison and static verification. All acceptance criteria are complete; hosted CI is separate pending proof under Ticket 07.
