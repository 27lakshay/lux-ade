# e2e-load-conformance

Status: returned
Type: slice evidence
Branch: claude/wf_59b7ac6e-d6c-5
Worker: ADE parallel build, E2E round 5, slice load-conformance
Requirements: R019, F140, R016 (daemon and protocol level), F098 (availability only). Advanced; none fully accepted.

## Outcome

No requirement in this slice is fully accepted. Each one still has a part
that needs Electron E2E, a feature that is not built, or real provider
accounts:

- **R019.** The load run now has every part of the register fixture, but the
  5 browser tabs are only the daemon's relay to a scripted owner. The
  renderer processes and their memory need Electron E2E.
- **F140.** The fault matrix now covers every fault class of architecture
  section 12, and the load matrix runs. Three faults are still gaps. The
  real-provider matrix needs explicit credentials, and the migration matrix
  is only partial.
- **R016.** The daemon and protocol parts already pass
  (`reliability-c/preview.spec.ts`). The viewer's frames, popups and renderer
  bridge need Electron E2E. This slice added nothing for R016.
- **F098.** Availability reporting is proven. Display and application
  control are not built.

No product bug was found in this area; every new spec passed against the
existing daemon.

## What changed

- **Load run (R019)**, `e2e/protocol/load/load.spec.ts`.
  - The spec moved here from `reliability-c/load.spec.ts`.
  - New in the fixture: 5 browser tabs behind a scripted owner, and 10,000
    imported history messages that are searched during load.
  - The sustained phase now lasts until 19 terminals have each streamed
    20,000 lines, not for a fixed 5 rounds.
  - A crash phase measures recovery time after a daemon SIGKILL under the
    full workload.
  - CPU per phase is recorded.
  - It is tagged `@load` and left out of the fault suite. Run it alone.
- **Admission timing**, `fixtures/load.ts` `AdmissionClient`.
  - Admission is now timed on a worker thread.
  - Timed on the test's main thread, the sustained p95 was 286 ms. That
    thread also parses 380,000 lines of terminal output, so the number
    measured the test process, not the daemon.
  - The worker thread still makes each call through the SDK's `call()`, with
    its connection and `hello`.
- **Fault class map (F140)**, `e2e/protocol/fault-suite.ts` `faultClasses`.
  - The map covers the 9 fault classes of section 12, with 46 faults. Each
    fault names the tests that inject it, or a `gap`.
  - A mapped test joins the suite even when its title has no vocabulary
    word. This adds `reliability-c/resources.spec.ts` (path replacement,
    registry migration), `reliability-c/plugin-update.spec.ts` and
    `reliability-b/uncertainty.spec.ts` (PID reuse).
  - `load/fault-classes.spec.ts` lists what the suite actually runs. It
    fails when a mapped test is renamed, deleted or dropped from the suite,
    and it reports each gap as a `fixme`.
- **New fault tests**, `load/fault-gaps.spec.ts`, for faults no other area
  injected:
  - Class 2: a cancel sent as a snooze falls due.
  - Class 5: concurrent credential verifications, and a sign-out or a
    disable during one.
  - Class 8: a browser owner that disconnects.
  - Class 9: an older client, and a daemon of an older runtime protocol.
- **F098 availability**, `load/computer-availability.spec.ts`.
- **Fixture**, `fixtures/browser-owner.ts`: `BrowserOwner.register()`
  registers the owner again after a daemon restart, as the desktop owner
  does when it sees a new `boot_id`.

## Acceptance criteria

### R019: use many active resources responsively

| Criterion part | Spec | Result |
|---|---|---|
| 10 agents, 20 terminals (3 services too) | `load/load.spec.ts` | pass |
| 5 browser tabs | same: 5 tabs through the daemon relay to a scripted owner, listed and inspected in every round and relayed again after the crash | pass at daemon level; Electron renderers not covered |
| Large searchable history | same: 20 imported Claude Code sessions, 10,000 messages, index caught up, searched every round | pass |
| Large diff | same: 5000 changed lines, `review.diff` every sustained round | pass |
| Slow consumer | same: a feed subscriber that never reads is evicted (`feed.subscribers_evicted` 1); terminal viewers that fall 64 frames behind are cut off and reattach (85 times) | pass |
| Sustained and idle phases | same, plus a daemon-crash phase | pass |
| Record p95 echo and admission | same (`ADE_E2E_LOAD_RESULTS`) | pass; admission p95 asserted under 250 ms in every phase, echo recorded only |
| Whole-process-tree memory | same: `phys_footprint` over 36 processes | pass for daemon, runtime and children; browser renderers not included |
| Bounded queues | same: every queue with a capacity is within it | pass |

Measurements: one run, alone (`ADE_E2E_WORKERS=1`). The host was an Apple
M4 with 10 logical CPUs and 24 GiB, with other workers' suites running
(load average 4.8 to 8.3).

| Measure | Sustained | Idle | After crash | Provisional target |
|---|---|---|---|---|
| Command admission p95, all operations (185, 111, 37 samples) | 69.9 ms | 24.2 ms | 21.3 ms | 250 ms (asserted) |
| `draft.save` p95 | 70.9 ms | 5.1 ms | | |
| `agent.send` p95 | 38.0 ms | 25.8 ms | | |
| `catalog.get` p95 | 32.7 ms | 32.6 ms | | |
| `history.search` p95 (10,000 messages) | 72.7 ms | 7.7 ms | | |
| `browser.list` p95 / `browser.inspect` p95 | 111.3 / 19.0 ms | 1.4 / 2.0 ms | | |
| Terminal echo p95 (550 and 30 samples) | 10.9 ms (max 135.9) | 0.6 ms | | 50 ms (recorded) |
| `review.diff`, 5000 lines, p95 of 5 | 332.5 ms | | | none |
| Process-tree CPU | 4.49 cores over 2.5 s | 1.24 cores | | none |
| Process-tree memory (`phys_footprint`, 36 processes) | 397 MiB | 398 MiB | 386 MiB | no budget yet (D16) |
| Queues | `runtime.agent_runs` 10 of 16; `feed.subscribers` 1; outbox and prompt queue 0; `terminal.scrollback` 5.0 MB (no capacity) | same | | bounded where a capacity exists |

Other numbers from the same run:

- History: the import took 568 ms and the index caught up in 1978 ms.
- Setup of the workload took 713 ms.
- Recovery after a daemon SIGKILL:
  - the new daemon's `hello` came at 82 ms;
  - the catalogue listed every Conversation at 86 ms;
  - a terminal reattached and echoed at 99 ms;
  - all services were running and the tabs were relayed again at 106 ms.

Two cautions about these numbers:

- Echo is measured on the test's main thread, which also parses every flood.
  It is an upper bound.
- This is one run. It is not a claim about a supported machine.

### F140: conformance and fault coverage

| Criterion part | Spec | Result |
|---|---|---|
| Fault matrix through public interfaces, as one named suite | `pnpm test:e2e:protocol:faults` | pass; see Checks |
| Every fault class of section 12 has an injecting test in the suite | `load/fault-classes.spec.ts` › every fault class… | pass |
| Class 1: competing profiles, deletion racing launch, replaced paths, registry migration and corruption under a live runtime | mapped (resources, reliability-c) | pass |
| Class 2: crash between phases, repeats, changed payloads, old callbacks, cancel against a new turn | mapped (reliability-a, conversations, terminals) | pass |
| Class 2: cancel while a wake arrives | `load/fault-gaps.spec.ts` › fault class 2… | pass (new) |
| Class 3: receipts, streams, slow clients, spool, actual state under saturation | mapped (recovery, reliability-a, reliability-b, ops) | pass |
| Class 3: saturate storage | `reliability-a/overload.spec.ts` › with the data volume full… | gap: runs only with `ADE_E2E_SYSTEM=1` (hdiutil) |
| Class 4: interrupted cursor persistence, expired cursors, late pages after rewind, profile switch, restore, new epoch | mapped (reliability-b, catalogs, files-git, context, backup) | pass |
| Class 4: late pages after a deletion | none | gap: no Conversation delete operation (`catalogs/history.spec.ts` fixme) |
| Class 5: replaced provider CLI; resume with incompatible adapter or account state | mapped (providers, adapters) | pass |
| Class 5: concurrent refresh; sign-out during refresh | `load/fault-gaps.spec.ts` › fault class 5… | pass (new) |
| Class 6: reload during work, late cleanup, data migration with an old worker, frozen backend host | mapped (reliability-c, plugins, devplug) | pass |
| Class 6: frozen UI plugin recovered from Electron main | none | gap: Electron E2E paused |
| Class 7: escaped and reparented descendants, ignored termination, reused PIDs and incarnations, quarantine | mapped (recovery, reliability-b, services, terminals) | pass |
| Class 8: remote disconnect, focus change, revoked pairing, no host or account substitution | mapped (remote, remote2, devplug) | pass |
| Class 8: browser owner disconnect; no browser substitution | `load/fault-gaps.spec.ts` › fault class 8… | pass (new) |
| Class 9: backup and restore with blobs and plugins; failed migrations | mapped (backup) | pass |
| Class 9: older client; older runtime | `load/fault-gaps.spec.ts` › fault class 9 (two tests) | pass (new) |
| Load matrix | `load/load.spec.ts` (`@load`, run alone) | pass |
| Migration matrix | `backup/restore.spec.ts` (one schema behind migrates, two behind refused), `reliability-c/resources.spec.ts` (newer registry) | partial: no matrix of every store's migration |
| Real-provider matrix | none | not covered: needs explicit credentials (12-S09) |

What the new fault tests prove:

- **Class 2.**
  - A cancel sent as a snooze falls due stops only the turn it names.
  - The wake is recorded once. No turn starts and nothing is queued.
  - A daemon crash afterwards records no second wake.
- **Class 5.**
  - Five `account.verify` calls, racing a credential rewrite, converge on
    one verified identity, and the generation does not change.
  - A sign-out between inspection and verification refuses the
    verification, and readiness reports `needs_authentication`.
  - A disable racing three verifications leaves the account `disabled`, with
    the generation raised by one and the identity cleared.
  - A verification from before the disable is refused, before and after a
    daemon crash.
- **Class 8.**
  - An owner that goes away without unregistering is reported as an error,
    with no tabs.
  - A new owner may register, but a request naming the old owner is refused
    and never reaches the new one.
  - The old owner cannot take the profile back while the new one is live
    (`conflict`).
- **Class 9, older client.** A daemon whose `hello` names
  `ade-application-v0` makes the SDK fail with `incompatible` and
  `not_sent`. Only the `hello` reached that daemon.
- **Class 9, older runtime.**
  - After a daemon SIGKILL, an `owner.claim` with an older runtime protocol
    is refused.
  - A compatible daemon then adopts the same runtime, and its shell is still
    running with the same PID and run ID.

### R016: preview content separate from application authority (daemon and protocol level)

| Criterion part | Spec | Result |
|---|---|---|
| Adversarial files, pages and popups through the daemon; no cross-profile data | `reliability-c/preview.spec.ts` (round 3 and 4) | pass, unchanged |
| A disconnected owner is never replaced for its requests | `load/fault-gaps.spec.ts` › fault class 8… | pass (new) |
| Frames, popups and the renderer bridge in the Electron viewer | none | not covered: Electron E2E paused |

### F098: computer and screen access (availability only)

| Criterion part | Spec | Result |
|---|---|---|
| Explicit host and display target; permission state | `load/computer-availability.spec.ts`; `devices/inventory.spec.ts` | pass |
| Availability is stable across listings, the CLI and a daemon restart | `load/computer-availability.spec.ts` | pass |
| Application or focus targets (`app:`, `window:`, `focused`) are refused, never redirected, and keep no receipt | same | pass |
| Display input is unavailable with a reason, and refused with it | same; `devplug/device-input.spec.ts` | pass |
| Handle OS permission denial | `devices/inventory.spec.ts` | partial: asserted only when this Mac denies |
| Application target control; input that never follows focus | `devices/control.spec.ts` | fixme: not built |

Machine safety for F098: the daemon reads permissions only through
`CGPreflightScreenCaptureAccess` and `AXIsProcessTrusted`, which never
prompt. No spec here captures a display, requests a permission or sends
input.

## Product fixes

None. Every new spec passed against the existing daemon.

## Operation tiers

No operation was added or changed.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=1 pnpm test:e2e:protocol:only load/load.spec.ts`: 1 passed (results above).
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only load/fault-classes.spec.ts load/fault-gaps.spec.ts load/computer-availability.spec.ts`: 7 passed, 3 fixme (the named gaps).
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:faults:only`: 344 passed, 13 skipped (fixmes, the named gaps and host-dependent skips), 1 failed, 5.7 min. 358 tests in all, up from 335.
  - The failure was `orchestration/parallel-runs.spec.ts` › runs that share the parent workspace…. A write failed with "lux-ade could not save these changes. Check available disk space and data-folder access". The disk had 123 GiB free.
  - It passed 12 of 12 on a rerun (`--repeat-each 3`), and it touches no code this slice changed. It is reported below and not fixed.
- `pnpm check:static`: pass.
- In-process tests added: none.
- Machine safety:
  - No spec or fixture in this slice calls the Security framework, the
    `security` tool or `hdiutil`.
  - After the runs, `pgrep` found no `ade-daemon`, `ade-runtime` or
    `security` process from this worktree.

## Observations (not fixed)

- **A save failure once, outside this area.** `orchestration/parallel-runs.spec.ts`
  failed once in the fault suite with the daemon's storage-write error while
  the disk had space. It did not reproduce in 12 reruns. Worth a look by the
  orchestration or storage owner if it recurs.

- **A terminal attachment can be closed before its snapshot arrives.**
  - Under a flood, a new attachment can fall 64 frames behind while its
    snapshot line is still being written. The runtime then closes it before
    any frame reaches the client.
  - This follows the documented rule: a slow viewer reconnects and never
    stalls the PTY. The load spec now retries such an attachment.
  - A viewer slower than the flood could keep missing its snapshot until the
    output stops. Nothing measured here showed that, and it is not fixed.
  - Code: `crates/ade-runtime/src/bin/supervisor/terminal_host.rs`,
    `broadcast` and `subscribe`.
- **`conversation.create` accepts a disabled account.** Readiness reports
  `account_disabled`, and a launch refuses the account. Whether creating the
  Conversation should also be refused is a product decision; it is outside
  this area.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 110 | 10 | 35 | 0 |

## References

- `docs/proposed-architecture.md` section 12 (in-repo): the fault classes and
  the provisional load fixture and targets.
- `.scratch/ade-v1/evidence/e2e-devplug.md`, `e2e-devices.md`,
  `e2e-reliability-c.md` (in-repo): the suite, the device fixtures and the
  earlier load spec this slice extends.
- `e2e/protocol/hooks-auth/auth.spec.ts` (in-repo), pattern: the raw runtime
  `owner.claim`.

## Open

- **R019.** Real browser tabs and their renderer memory need Electron E2E.
  There is no memory budget yet (decision D16), and `terminal.scrollback`
  reports no capacity.
- **F140.**
  - The real-provider matrix needs explicit credentials and a run the user
    starts (12-S09).
  - The migration matrix covers backups one schema behind and a newer
    registry format, not every store.
  - The three gaps are listed above.
- **R016.** The Electron viewer is for the UI phase.
- **F098.** Display and application control is not built.
- **Coordinator.**
  - `reliability-c/load.spec.ts` moved to `load/load.spec.ts`. The R019
    rows in `e2e-reliability-c.md` still name the old path; this slice left
    that file unchanged.
  - The fault suite gained `grepInvert: loadRun` in
    `playwright.faults.config.ts`, so the heavy load run stays out of it.
- Requirement IDs whose full register acceptance now passes: none.
