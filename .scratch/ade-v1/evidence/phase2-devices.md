# Devices

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-9
Worker: Phase 2 round D, devices slice
Requirements: F098 (computer and screen access), F099 (iOS simulator integration), F100 (Android device and emulator integration), under decision D12. Advanced, not accepted.

## Outcome

The daemon now discovers the host's displays, iOS simulators and Android devices and AVDs, and reports each family's and each capability's availability with a reason code. It can capture a PNG of one exact device, and boot, install and launch through effect commands with receipts in the profile database. `ade device …` exposes all five operations. No requirement is fully accepted: F098–F100 still need E2E and UI evidence, and control (input) is not built.

## Operation tiers

| Operation | Tier | Notes |
|---|---|---|
| `device.list` | query | Optional `family` filter. Reports host identity, per-family tools, macOS permission state (screen recording, accessibility), and per-device capabilities with reasons. |
| `device.screenshot` | query | Returns a base64 PNG of at most 16 MiB; keeps no file. |
| `device.boot` | effect command | iOS through `simctl bootstatus -b`; an AVD through `emulator -avd` in its own process group, then waits for `sys.boot_completed`. |
| `device.app.install` | effect command | Reads the app's identity and version from the bundle (`plutil` or `aapt2 dump badging`) before the receipt, then confirms the device reports that version. |
| `device.app.launch` | effect command | Settles only when the device reports a process ID (`simctl launch` output or `pidof`). |

Targeting rules:

- Every targeted request names `host_id` and a stable `device_id`: `display:<uuid>`, `ios-sim:<udid>`, `android-avd:<name>` or `android-serial:<serial>`. There are no defaults, and the daemon does not follow focus.
- A `host_id` that is not the daemon's own is refused. The host ID is derived from `IOPlatformUUID` (macOS) or `/etc/machine-id` by a salted hash.
- An emulator's adb serial is only a port number. It is re-checked against the AVD name before and after a capture, install or launch.
- A display capture runs only when exactly one display is active. It is discarded unless the display list is unchanged and the PNG is an integer multiple of that display's size.

Receipts and reconciliation:

- Refusals happen before a receipt is written. A receipt is then recorded as dispatched before the effect runs.
- A replayed ID returns the stored outcome.
- An open boot receipt is reconciled by looking at the device. If the device is booted, the receipt settles as success. If it is still booting, the receipt stays open. If it is not booted, the receipt settles as failed and the boot is not retried.
- An open install receipt settles as success only if the recorded app ID and version are installed.
- An open launch receipt becomes unknown. The launch is never rerun.
- Timed-out or unverifiable installs and launches become unknown.

## Checks

- `pnpm check:static`: passed on the final commit (rustfmt, contract check, architecture, sdk build, typecheck, fallow, js build, js pure tests, clippy, legacy Rust tests: 456 passed).
- In-process tests added:
  - `crates/ade-daemon/src/devices.rs`: identity parsing, host identity, simctl JSON, adb/avd/emu/aapt/dumpsys/resolve-activity/pidof parsing, SDK discovery, and classification of all three families from sample output. Also covers PNG dimension checks and boot and install replay decisions.
  - `crates/ade-core/src/contract/devices.rs`: schema round-trips, declared tiers, and rejection of requests without a target.
- Manual, not committed: a temporary in-process probe ran on this Mac and was then deleted. It confirmed that the FFI links. It reported screen recording and accessibility as granted (attributed to the terminal), one built-in display, iOS simulators all `runtime_missing` (their runtime is not installed), and the Android SDK found with AVD `Pixel_9_Pro` bootable. The display capture returned a 2940×1912 PNG that passed the dimension check.

Verified only statically or by sample output:

- Boot, install and launch were never run against a real simulator or emulator. No runtime is installed, and booting an emulator on the user's Mac was out of bounds for this session.
- Physical Android devices, the `unauthorized` and `offline` states, and wireless adb are covered by sample output only.
- The permission-denied path is covered by classification tests only; this host has both permissions granted.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 10 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/main/emulator/simctl-simulator-devices.ts`, pattern + adapted: simctl JSON shape and Xcode-missing classification → `crates/ade-daemon/src/devices.rs`
- Orca, `src/main/emulator/android/adb-devices.ts`, adapted: `adb devices -l` grammar including `no permissions` → `crates/ade-daemon/src/devices.rs`
- Orca, `src/main/emulator/android/avd-manager.ts`, adapted: `-list-avds` log-line filter → `crates/ade-daemon/src/devices.rs`
- Orca, `src/main/emulator/android/android-sdk-discovery.ts`, adapted: SDK root order → `crates/ade-daemon/src/devices.rs`
- Orca, `src/main/emulator/android/android-device-inventory.ts` and `android-avd-boot.ts`, pattern: `emu avd name` to map serial to AVD, and waiting for a boot.
- Orca, `src/main/computer/macos-computer-use-permission-status.ts`, studied: permission model (Orca uses a helper app; ADE asks CoreGraphics and HIServices directly without prompting).

## Open

- Input control (tap, type, key) for displays, simulators and Android is not built. The accessibility permission is reported for it.
- Capturing one display among several needs ScreenCaptureKit or a verified display index. Until then, multi-display capture is refused with `target_unverified`.
- Live view or streaming, simulator and emulator shutdown, AVD creation, app uninstall, and logcat are not built.
- iOS physical devices (`devicectl`) and Linux or Windows screen access are not built.
- An AVD boot does not survive a restart as a daemon-owned lease. The emulator runs in its own process group and is not stopped on quit.
- A long boot holds the daemon's admission read lock for up to its timeout (300 s at most).
- E2E coverage for F098–F100 and the 08-S12 disconnect path waits for the UI phase.
- Coordinator: add a THIRD-PARTY-NOTICES entry for the Orca (MIT, Copyright (c) 2026 Lovecast Inc.) portions adapted into `crates/ade-daemon/src/devices.rs`.
