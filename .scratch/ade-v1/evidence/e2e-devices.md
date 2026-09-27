# E2E round 2: devices

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-8
Worker: ADE parallel build, E2E round 2, devices worker
Requirements: F098, F099, F100 (08-browser-devices, decision D12); 08-S12 for devices. Advanced, not accepted.

## Outcome

Headless E2E now proves device discovery, availability reasons, and the boot,
install and launch effect commands against real daemons and runtimes. The
suite is `e2e/protocol/devices/`: 21 tests pass and 3 are `test.fixme`. The
simulator and Android tools are PATH and SDK-root shims that return recorded
tool output. Screen-recording permission comes from the real macOS API.

No requirement is fully accepted. F098, F099 and F100 each require control
(input) of the selected target, and no input operation exists. F098 also
requires application targets and caller attribution, which are not built.

## Acceptance criteria

| Requirement | Acceptance (08 spec) | Spec | Result |
|---|---|---|---|
| F098 | Select an explicit host and display target | `inventory.spec.ts` "screen access reports the real macOS permission state explicitly"; "targeted operations name this host and an exact device…" (another host ID is refused for every targeted operation, including `device.screenshot`) | pass |
| F098 | Handle OS permission denial | `inventory.spec.ts` "screen access…" asserts each permission is `granted` or `denied` with a subject, and that `denied` screen recording blocks capture with `permission_denied`. This Mac grants the permission, so the denied branch is asserted only conditionally | partial: denial cannot be forced on a real host |
| F098 | Application target and caller attribution | none | not covered: no application target or attribution exists |
| F098 | Input control; no redirect on focus change | `control.spec.ts` F098 | fixme: no input operation |
| F099 | Discover installed supported simulators | `inventory.spec.ts` first test (iOS runtimes only; watchOS dropped; booted, shut-down and runtime-less simulators with per-capability reasons) | pass |
| F099 | Report missing Xcode, runtimes and permissions clearly | `inventory.spec.ts` "a host without Xcode…" (`tool_missing`), "a failing simctl… no runtimes…" (`tool_failed`, `runtime_missing` for no runtimes and for runtime-less simulators) | pass |
| F099 | Select one simulator with host identity | `inventory.spec.ts` host tests (wrong host refused, bad IDs refused, stable host ID across restarts and profiles); `ios.spec.ts` "a simulator deleted after listing…" (refused, no other simulator touched; a lowercase UDID names the same simulator) | pass |
| F099 | View it | `ios.spec.ts` first test (`device.screenshot` through the SDK and the CLI; the CLI refuses to overwrite a file) | pass |
| F099 | Boot, install, launch as effect commands | `ios.spec.ts` first test (receipts, replay without rerunning simctl, conflict on the same ID with other parameters, durable across a daemon kill) | pass |
| F099 | Control it | `control.spec.ts` F099 | fixme: no input operation |
| F100 | Discover adb devices and emulators | `inventory.spec.ts` first test (running AVD named by AVD not serial, shut-down AVD, physical `unauthorized`, `offline`, `no permissions`) | pass |
| F100 | Missing tools reported as unavailable | `inventory.spec.ts` "a host without Xcode or the Android SDK…" (three `tool_missing` reasons, no devices) | pass |
| F100 | Select one, view it; boot, install, launch | `android.spec.ts` first test (AVD boot through the emulator, APK install, launch with PID, screenshot, replays without rerunning adb or the emulator, CLI install and launch) | pass |
| F100 | Authorization failure without switching devices | `android.spec.ts` "unauthorized, offline and permission-less devices refuse effects…" (and the same operation ID runs once the key is accepted) | pass |
| F100 | Disconnect without switching devices (08-S12) | `android.spec.ts` "a disconnected emulator fails its next operation without touching the AVD that took its serial" | pass |
| F100 | Control it | `control.spec.ts` F100 | fixme: no input operation |

Fault cases covered:

- Restarts and crashes: daemon SIGKILL during a simulator boot before and after
  the effect, during a simulator install before and after, during a simulator
  launch, during an adb install, during `am start`, and during an AVD boot. Each
  replay reconciles by observing the device (boot, install) or becomes unknown
  (launch), and no tool runs twice (`ios.spec.ts`, `android.spec.ts`).
- Duplicate requests: a concurrent duplicate of a running boot is refused; a
  second operation on the same device is refused while one runs; a caller that
  lost its reply retries the ID and gets the one install that ran
  (`ios.spec.ts`).
- Conflicts: the same operation ID with other parameters (`ios.spec.ts`);
  device claims across two profiles sharing one host registry: a run hold, an
  in-flight effect, and a crash that quarantines the claim until the owner's
  replay reconciles and releases it (`claims.spec.ts`).
- Uncertain outcomes: simctl prints no PID; the install cannot be verified;
  the device reports another version (settled failure). An unknown outcome
  quarantines the device claim, which then refuses this profile too until
  `resources.claim.resolve` (`ios.spec.ts`).
- Refusals keep no receipt: a refused operation ID later runs (`inventory.spec.ts`,
  `android.spec.ts`, `claims.spec.ts`).

## Product fixes

- `crates/ade-daemon/src/sessions/devices.rs`: xcrun was hard-coded to
  `/usr/bin/xcrun`. It now resolves through the host tool directories (the
  daemon's PATH first, then `/usr/bin`), the same resolution adb and the
  emulator use. This lets the E2E shim replace it, and lets a user's selected
  xcrun win.
- Same file: a case variant of a simulator UDID (`ios-sim:<lowercase>`) passed
  the ID check but was then refused as "not attached", because lookups compared
  the raw string while claims used the canonical ID. Device requests now use the
  canonical ID for lookup, claims, receipts and the reply.
- Same file: the unknown-outcome message told the caller to "use a new operation
  ID", but the quarantined device claim refuses every new ID. It now names
  `resources.claim.resolve` as the step before a new ID.

No pure-core test was added: the canonical-ID decision reuses `Target::parse`
and `Target::id`, which `devices.rs` tests already cover.

## New generic fixtures

- `e2e/protocol/fixtures/device_tools.py`: one shim for `xcrun simctl`, `adb`,
  `emulator` and `aapt2`, driven by a fixture host's `state.json`, recording
  each effect in `calls.jsonl`, with holds that pause an action and exit when
  the daemon dies.
- `e2e/protocol/fixtures/devices.ts`: `DeviceHost` (create, `env()`, state
  changes, holds, recorded calls, `.app` and APK stand-ins) and `sampleState()`.

## Operation tiers

Unchanged: `device.list` and `device.screenshot` are queries; `device.boot`,
`device.app.install` and `device.app.launch` are effect commands.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/devices`: 21 passed, 3 fixme.
- `pnpm check:static`: passed.
- No `ade-daemon` or `ade-runtime` from this worktree left running (pgrep).
- In-process tests added: none.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 5 | 15 | 0 |

## References

None.

## Open

- Input control for displays, simulators and Android devices, and F098's
  application targets and caller attribution, are not built (`control.spec.ts`).
- The permission-denied path for screen recording runs only on a host that
  denies it; this Mac grants it.
- The "no Android SDK" test skips itself on a machine with adb or the emulator
  in a standard PATH directory (`/opt/homebrew/bin`, `/usr/local/bin`), since
  the daemon falls back to those.
- Coordinator: `e2e/protocol/fixtures/environment.ts` strips `ADE_`, `CODEX_`
  and similar prefixes but not `ANDROID_HOME` or `ANDROID_SDK_ROOT`. A spec that
  does not set them lets a daemon reach the user's real Android SDK. The device
  specs set both; adding `ANDROID_` to the stripped prefixes would close it for
  every spec.
- Requirement IDs whose full register acceptance now passes: none.
