# Direct remote execution and SSH

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need to control agents and workspaces on their machines without relocating work or leaking account state when a connection changes.

## Solution

Support explicit authenticated direct and SSH connections to independent compatible backends, with host-specific resources and revocation.

## User Stories

1. As a user, I want support for Direct LAN/VPN connectivity, so that I can connect to my backend without a relay. **F121**
2. As a user, I want support for Pairing and revocation, so that I can authorize clients and remove access. **F122**
3. As a user, I want support for SSH bootstrap and connection, so that I can use an existing remote machine. **F124**
4. As a user, I want support for Remote workspaces, so that I can run agents, files and Git on another host. **F125**
5. As a user, I want support for Multiple execution hosts, so that I can manage work across machines. **F126**
6. As a user, I want support for Execution placement, so that I can choose where new work runs. **F127**
7. As a user, I want support for Remote previews and device access, so that I can inspect remote-host resources. **F129**
8. **11-S08.** As a user, I want to retain remote work during network loss, so that I can reconnect without starting duplicates.

## Implementation Decisions

1. Local profiles reference explicit remote host/profile connections. Paths, credentials, native sessions and workspaces remain execution-host-owned.
2. Pairing establishes explicit trust; revocation invalidates future access/reconnections under the defined session policy. Direct connectivity must authenticate endpoints and transport.
3. SSH bootstrap verifies the destination host and compatible backend artifacts. Preserve unrelated remote setup; any installation writes and credentials transfer are explicit operations.
4. Link loss changes observability to disconnected/unknown; it is not permission to relaunch locally or migrate ownership.
5. Capability-aware placement is an explicit choice; multiple hosts do not imply a distributed scheduler. Keep cursor history epochs and operation identities correctly scoped.
6. Remote preview/device access requires a named supported transport/platform combination. Unavailable capability stays unavailable; do not redirect to a local device.
7. Independent headless infrastructure is v1 for remote execution. A polished standalone deployment product and relay are not prerequisites.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Connection manager, trust/pairing, SSH bootstrap, SDK transport and remote daemon/runtime.

Prior art: Paseo client/server separation; Orca host relocation and stale terminal-frame cases; prototype version handshake. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F121 | Connect to an authenticated explicit endpoint, validate identity and observe revocation/link failure without exposing an unauthenticated listener. |
| F122 | Pair using an explicit trust flow; revoke access and reject subsequent operations/reconnections without removing remote work. |
| F124 | Verify host identity, install compatible declared artifacts, connect and reconnect without copying credentials or overwriting unrelated configuration. |
| F125 | Perform a remote workspace flow and verify paths/processes/data stay on that host; disconnection reports unknown state rather than local fallback. |
| F126 | Register several hosts, label their resources unambiguously and reconnect independently without cross-host cursor or account confusion. |
| F127 | Choose a host/workspace explicitly using readiness/capability information; preserve the choice through retries and reject incompatible placement. |
| F129 | Expose an explicitly selected reachable preview/device capability through the host adapter; distinguish unavailable transport/platform features and preserve target identity. |
| 11-S08 | Disconnect a host during a turn, reconnect, and verify the original remote attempt and absence of local fallback. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Relay, disposable VM/container environments, automatic host migration and polished self-host service deployment are out of scope.

| Feature | Disposition |
|---|---|
| F123 — Relay connectivity | Design now, ship later |
| F128 — Disposable VM/container environments | Not now |
| F130 — Polished self-host deployment product | Not now |

## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
