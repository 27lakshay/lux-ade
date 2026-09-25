# Browser, computer and device integration

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need to inspect and operate the application they are building with precise targeting and predictable resource ownership.

## Solution

Provide explicit browser sessions and host-owned computer/device capabilities that agents can use through the same application authority.

## User Stories

1. As a user, I want support for Embedded browser, so that I can preview applications beside agent work. **F091**
2. As a user, I want support for Browser profiles, so that I can separate browser account state. **F092**
3. As a user, I want support for Browser import, so that I can bring supported browser state into ADE. **F093**
4. As a user, I want support for Design context capture, so that I can give an agent precise browser context. **F094**
5. As a user, I want support for Agent browser automation, so that I can let agents operate the intended preview. **F095**
6. As a user, I want support for Browser diagnostics, so that I can inspect page failures. **F096**
7. As a user, I want support for Browser recording, so that I can review and share captured browser activity locally. **F097**
8. As a user, I want support for Computer and screen access, so that I can give authorized agents native context and control. **F098**
9. As a user, I want support for iOS simulator integration, so that I can inspect and operate simulated apps. **F099**
10. As a user, I want support for Android device and emulator integration, so that I can inspect and operate Android apps. **F100**
11. **08-S11.** As a user, I want to keep unrelated pages outside ADE authority, so that I can preview arbitrary applications safely.
12. **08-S12.** As a agent, I want to receive an unavailable result when my target closes, so that I can avoid acting on a different resource.

## Implementation Decisions

1. Ordinary browser tabs belong to Electron with profile-partitioned storage. Unattended browser jobs use explicitly created runtime-owned sessions.
2. Closing a frontend-owned resource can make automation unavailable. Do not silently promote it to a background job or substitute another tab/device/host.
3. Import or transfer browser state is explicit and capability-limited. Do not promise arbitrary DOM/network/encrypted state migration.
4. Navigation, redirects, child frames and popups retain untrusted-page boundaries. Trusted installed code does not grant viewed content the application bridge.
5. Automation targets stable session identity. Coordinate debugger attachment and show detachment/conflict with DevTools.
6. Computer capture/control, iOS simulator and Android adapters belong to physical execution hosts and respect actual OS/device permissions. Same user authority does not bypass OS consent.
7. Recording declares target, capture kind, start/stop and local artifact lifecycle. Decide exact video/action/network recording formats before shipping; do not infer a complete replay system.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Electron browser owner, background browser owner, automation adapter, capture and device adapters.

Prior art: t3code explicit preview assignment and popup handling; reference projects' native integration paths. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F091 | Open profile-scoped tabs, navigate and recover metadata; keep untrusted pages, popups and redirects outside the application bridge. |
| F092 | Create/select partitions, persist their state, and verify cookies do not cross profile boundaries. |
| F093 | Preview supported import source/data classes, import explicitly, preserve source data and report unsupported/encrypted items without promising full session cloning. |
| F094 | Capture selected page context with target identity and preview; changing focus cannot redirect capture to another page. |
| F095 | Target a stable browser session through the public operation path; report unavailable owners and never silently switch tabs or execution hosts. |
| F096 | Inspect supported console/network/runtime diagnostics for the selected target with bounded retention and visible attachment failures. |
| F097 | Start/stop a recording with explicit target and capture scope, save a local artifact, and disclose coverage gaps; artifact publishing remains excluded. |
| F098 | Select an explicit host/display/application target, handle OS permission denial and preserve caller attribution; no automatic redirect on focus change. |
| F099 | Discover installed supported simulators, select one, view/control it with host identity and report missing Xcode/runtime/permissions clearly. |
| F100 | Discover supported adb devices/emulators, select one, view/control it and handle disconnect or authorization failure without switching devices. |
| 08-S11 | Navigate, redirect and open popups to fixture pages; verify no application bridge is exposed. |
| 08-S12 | Close the selected browser/device; its next operation fails without touching the newly focused target. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Automatic browser state migration, artifact publishing and universal remote device parity are not promised. Capture formats/source import roster remain explicit delivery decisions.


## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
