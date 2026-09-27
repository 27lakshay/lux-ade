# E2E round 3: devices, plugin development and fault conformance

Status: returned
Type: slice evidence
Branch: claude/wf_317b0f50-41b-10
Worker: ADE parallel build, E2E round 3, devices-plugins-dev worker
Requirements: F099, F100 (register acceptance now passes as E2E); F098, F060, F139, F140 (advanced, not accepted)

## Outcome

Device control now exists. `device.input` is a new effect command that sends
one tap, swipe, text or key event to one exact booted simulator (through
`idb`) or Android device (through `adb shell input`), and records who asked.
With it, every part of the F099 and F100 register acceptance passes as
headless E2E against the PATH and SDK-root shims.

A failing backend plugin is now proven contained ("safe mode"): its failures
count toward the bounded restart schedule, it ends `errored` and is never
started again on its own, and the core and other plugins keep working across a
daemon restart. The specs found one product bug here: a plugin hanging in
activation blocked its own `plugin.host.status` for up to 15 s. That is fixed.

`pnpm test:e2e:protocol:faults` now runs the fault conformance suite across
every area (218 tests in 81 files at this commit).

Not accepted:

- F098: display and application input is not built.
- F060 and F139: their UI parts (UI plugin reload, frozen renderer, Electron
  main restart, component previews) need Electron E2E, which is paused.
- F140: load, migration and real-provider matrices are not part of this suite.

## Acceptance criteria

Specs are under `e2e/protocol/devplug/` unless another path is given.

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| F098 | Explicit host and display target; OS permission state | `devices/inventory.spec.ts` (round 2) | pass (denial asserted only when this Mac denies it) |
| F098 | Caller attribution | `device-input.spec.ts` "F100: input reaches only the selected Android device, attributed to its caller…" (`user` and `agent:<conversation>`, an invented Conversation is refused, the CLI `--agent` flag) | pass for device input |
| F098 | Display input is refused explicitly, never sent to what has focus | `device-input.spec.ts` "F098: display input is offered by no display…" | pass |
| F098 | Application target; input to a display or application that never follows focus | `devices/control.spec.ts` | fixme: not built |
| F099 | Discover simulators; report missing Xcode and runtimes | `devices/inventory.spec.ts` (round 2) | pass |
| F099 | Select one with host identity; view it | `devices/ios.spec.ts`, `devices/inventory.spec.ts` (round 2) | pass |
| F099 | Control it: input reaches only the selected simulator; a lowercase UDID names the same one; shut-down, deleted and no-Back-key cases are refused and idb never runs | `device-input.spec.ts` "F099: input reaches only the selected simulator through idb…" | pass |
| F099 | Missing control tool reported clearly (`tool_missing` naming idb; viewing still works) | `device-input.spec.ts` "F099: without idb…" | pass |
| F099 | Fault: input cut by a daemon kill is unknown and never resent | `device-input.spec.ts` "F099 fault…" | pass |
| F100 | Discover, select, view; boot, install, launch | `devices/android.spec.ts`, `devices/inventory.spec.ts` (round 2) | pass |
| F100 | Control it: tap, text (quoted for the device shell), swipe and key reach only the selected device's serial; replay without resend; conflict; bounds refused before a receipt; a device-side `Error:` settles as a failure | `device-input.spec.ts` "F100: input reaches only the selected Android device…" | pass |
| F100 / 08-S12 | Authorization failure, offline, no permissions, not booted, another host, a closed AVD whose port another AVD took, an unplugged serial: all refused, nothing reaches another device, and refusals keep no receipt | `device-input.spec.ts` "F100/08-S12: unauthorized, offline and disconnected devices…" | pass |
| F100 | Faults: duplicate in flight (same ID, same device), daemon kill mid-input gives unknown, quarantined claim until `resources.claim.resolve`, never resent | `device-input.spec.ts` "F100 faults…" | pass |
| F060 | Reload a backend extension | `plugins/dev-reload.spec.ts` (round 1) | pass |
| F060 | A reload whose code throws in activate is reported on the reload and in host status, supervised to `errored`, and the next edit that fixes it serves | `dev-recovery.spec.ts` | pass |
| F060 | Inspect bounded logs: at most 200 lines, long lines cut with `…`, newest last | `plugin-recovery.spec.ts` "the plugin log is a bounded tail…" | pass |
| F060 | Keep active provider leases valid across a reload | `adapters/plugin-providers.spec.ts` "04-S11: a dev-mode reload keeps a leased provider Conversation…" | pass |
| F060 | Safe mode for a failing backend: activation that throws, exits or hangs is bounded to 4 attempts then `errored`; no automatic start after that or at daemon boot; core and another plugin keep working across a daemon kill; status stays answerable during a hang; fix plus `plugin.host.restart` recovers; disable and re-enable start clean | `plugin-recovery.spec.ts` "safe mode…", "a host that exits during activation…" | pass |
| F060 | A frozen backend host: health probe reports it unresponsive; `plugin.host.restart` replaces it; the frozen call settles `outcome_unknown` and is never rerun | `plugin-recovery.spec.ts` "a frozen host…" | pass |
| F060 | Reload a UI extension; recover a frozen UI plugin through a fresh renderer | none | not covered (Electron E2E paused) |
| F139 | Inspect plugin errors; do not kill active provider workers on reload | `dev-recovery.spec.ts`, `plugin-recovery.spec.ts`, `adapters/plugin-providers.spec.ts` | pass |
| F139 | React UI reload, safe Electron main restart, component previews | none | not covered (Electron E2E paused) |
| F140 | Fault matrix through public interfaces, as a named suite | `pnpm test:e2e:protocol:faults` (`playwright.faults.config.ts`, `e2e/protocol/fault-suite.ts`) | pass; see Checks |
| F140 | Load, migration and real-provider matrices | none | not covered |

## Product fixes

1. **Device control (F098–F100): `device.input` was missing.**
   - Contract, in `crates/ade-core/src/contract/devices.rs`:
     - the `device.input` effect command;
     - `DeviceInputAction` (`tap`, `swipe`, `text`, `key`) and `DeviceKey`;
     - the `input` capability;
     - a required `caller`, which reuses `orchestration::Caller`.
   - Pure core, in `crates/ade-daemon/src/devices.rs`:
     - `input_attribution` and `validate_input`;
     - `android_input_args`: quotes text for the device shell, turns spaces
       into `%s` and refuses a literal `%s`;
     - `idb_input_args`: HID key codes; an iOS simulator has no Back key;
     - an `input` capability for every device. A display is `not_supported`,
       or `permission_denied` without Accessibility. A simulator without
       `idb` is `tool_missing`.
     - The iOS family lists `idb` among its tools when found.
   - Daemon, in `crates/ade-daemon/src/sessions/devices.rs`:
     - The flow is peek, validate, dispatch, then run.
     - It confirms an emulator's serial still belongs to its AVD right before
       sending.
     - A replay of an open receipt is unknown.
     - An Agent caller must name an existing Conversation.
   - CLI: `ade device input HOST DEVICE --request-id ID (--tap X,Y | --swipe
     X1,Y1,X2,Y2 [--duration-ms N] | --text TEXT | --key KEY) [--agent ID]`.
   - Test: `devices::tests::input_is_bounded_attributed_and_quoted_for_each_tool`.
2. **A hanging plugin hid its own status (F060).**
   - `Hosts::start` holds the slot lock during `activate` (up to 15 s), and
     `restart` holds it during `deactivate` (up to 5 s). `plugin.host.status`
     waited on the same lock.
   - Now the slot publishes the host it waits on. `status` waits at most
     200 ms for the lock, then reports that host as `running` with its PID and
     log tail. The tail's last line names what the slot waits for.
   - `status` also drops the slot lock before its health probe.
   - File: `crates/ade-daemon/src/plugins/host.rs`.
   - No decision is involved, so no pure-core test was added.

## New fixtures

- `e2e/protocol/fixtures/device_tools.py` and `devices.ts`:
  - an `idb` shim, created by default; `{ idb: false }` leaves it out;
  - `adb shell input`;
  - `adb-input` and `idb-input` holds;
  - an `input_error` switch;
  - the `input`, `serial` and `udid` fields on recorded calls.
- `e2e/protocol/fixtures/plugins/faulty/` and `fixtures/faulty-plugin.ts`:
  - the `e2e.faulty` backend. Its activation throws, exits or hangs while a
    switch file exists in its `out_dir`.
  - Commands: `freeze`, which blocks the event loop, and `noise`, which floods
    the log.
- `e2e/protocol/fault-suite.ts` and `playwright.faults.config.ts`: the fault
  conformance suite, documented in `e2e/protocol/README.md`.
- `package.json`: `test:e2e:protocol:faults` (builds) and `test:e2e:protocol:faults:only`.

## Changed earlier specs

- `devices/inventory.spec.ts`: the iOS family's tools now include the `idb` shim.
- `devices/control.spec.ts`:
  - The F099 and F100 fixmes are replaced by `devplug/device-input.spec.ts`.
  - The F098 display and application fixme stays.

## Operation tiers

- `device.input`: effect command (new). Replaying an open receipt gives
  `unknown`, because delivery of an input cannot be observed.
- Nothing else changed.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/devplug`: 12 passed.
- The same with `devices`, `plugins` and `adapters/plugin-providers.spec.ts`:
  56 passed, 1 skipped (the F098 fixme).
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:faults:only`: 211 passed, 7 skipped (fixmes and host-dependent skips), 3.8 min.
- `pnpm check:static`: pass.
- In-process tests added: `crates/ade-daemon/src/devices.rs`,
  `input_is_bounded_attributed_and_quoted_for_each_tool`.
- `pgrep`: no `ade-daemon` or `ade-runtime` from this worktree left running.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 100 | 10 | 40 | 0 |

## References

- facebook/idb `idb/cli/commands/hid.py` (GitHub, main): the `ui tap`,
  `swipe --duration` (seconds), `text`, `key` (HID keycode) and `button`
  argument shapes. Studied only; no code copied.

## Open

- **Decision D12 (the user's call).** Simulator input depends on `idb`
  (idb-companion plus fb-idb). simctl has no touch or key input. D12 asks
  for the supported tools to be defined, so the choice of `idb` should be
  recorded in `decisions.md`.
  - The alternative is a bundled HID helper.
  - The argument shapes follow idb's source. No real `idb` ran here; it is
    not installed on this Mac.
- **F098.** Display and application input is not built.
  - It needs an `app:<bundle>` target, delivery to that process, such as
    `CGEventPostToPid`, and the Accessibility permission.
  - An E2E proof that sends no input to the user's live session also needs
    a safe fixture application.
- **F140.** Load, migration and real-provider matrices are still separate.
  - The fault suite selects tests by a fault vocabulary in the file path or
    title, or by a `@fault` tag, so a few tests that inject no fault match
    too.
- **Harness (outside this area).** One daemon and its runtime outlived the
  harness cleanup (PID 1 parent) in an early, failing run.
  - That test failed on an SDK timeout while a `plugin.host.restart` was
    still blocked in the daemon. This was before the status fix.
  - The ledger check did not report or kill them. I killed them by hand.
  - Every later run left nothing behind. Suspected cause: `profile.stop()`
    does not escalate to SIGKILL when a failed test leaves a request in
    flight. Not investigated further.
- Requirement IDs whose full register acceptance now passes: **F099, F100**.
