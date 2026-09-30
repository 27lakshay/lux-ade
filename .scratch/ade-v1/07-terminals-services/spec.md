# Terminals, dev services and ports

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need persistent responsive terminals and discoverable dev services without losing state when the UI reloads or multiple profiles compete.

## Solution

Use Ghostty WebAssembly as the presentation adapter over Rust-owned execution, with explicit restoration, port ownership and service lifecycle.

## User Stories

1. As a user, I want support for Persistent terminals, so that I can keep shell work alive independently of panes. **F081**
2. As a user, I want support for Terminal ergonomics, so that I can use a comfortable daily terminal. **F082**
3. As a user, I want support for Programmatic terminal access, so that I can let CLI and agents operate terminals. **F083**
4. As a user, I want support for Dev port discovery, so that I can see which services are listening. **F085**
5. As a user, I want support for Managed dev services, so that I can start and stop workspace services. **F086**
6. As a user, I want support for Port allocation, so that I can avoid avoidable local service conflicts. **F087**
7. As a user, I want support for Stable dev URLs and proxying, so that I can open services through predictable addresses. **F088**
8. As a user, I want support for Peer-service environment wiring, so that I can connect related workspace services. **F089**
9. As a user, I want support for Workspace scripts, so that I can run project-defined workflows. **F090**
10. **07-S10.** As a user, I want to stop existing work even when output and ordinary commands saturate, so that I can recover control.
11. **07-S11.** As a user, I want to know when terminal recovery is incomplete, so that I can avoid trusting a fabricated screen.

## Implementation Decisions

1. Rust owns PTYs and process lifetime. Ghostty WebAssembly handles terminal presentation; terminal bytes bypass React state and the ordinary application reducer. The native core is the sole query responder.
2. Build native and WebAssembly Ghostty from the same pin and prove exact Ghostty snapshot restoration under D06. The window never answers terminal queries. The CLI attach path retains its separately declared xterm replay format.
3. Byte offsets, runtime incarnation, resize ordering and viewport/input ownership govern attachment. Do not reconstruct arbitrary terminal state from a visible-cell dump or an arbitrary output tail.
4. Bound per-client/run/profile/host queues by items and bytes. A slow client resynchronizes without blocking other clients. Reserve stop/control capacity even when ordinary receipts or storage are saturated.
5. Output overflow means degraded/output-failed state, not an invented execution exit. Finite spool storage implies a documented maximum recoverable outage.
6. Port probing is advisory. Strong reservation requires retained socket handoff when supported; otherwise verify the listener and surface bind races. Never silently remap a supposedly stable endpoint.
7. Stable URL proxying must preserve HTTP/WebSocket behavior and explicit target host. Public aliases remain a selected capability requiring exposure-policy design, not implicit internet exposure.
8. Workspaces own explicit service recipes and peer dependencies. A service stop verifies managed execution before releasing claims; arbitrary escaped descendants remain uncertain.

## Testing Decisions

Feature acceptance uses end-to-end tests; pure-core and renderer browser tests remain allowed under the current project test policy. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Runtime, terminal adapter, public terminal commands, service manager, HostResources and proxy.

Prior art: Prototype terminal byte-offset/resize cases and replay overflow gap; Paseo viewport ownership; Orca terminal liveness and descendant tests. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F081 | Detach/reopen while a real shell and interactive program run; recover supported modes, screen and ordered output without restarting the shell. |
| F082 | Exercise fit, search, links, selection/copy, keyboard/IME, Unicode, themes and supported renderer recovery with retained process identity. Apply the terminal rows of the [theming acceptance matrix](../01-foundation/theming.md#acceptance-matrix). |
| F083 | Create, inspect, write, resize and stop through authenticated public commands; enforce target/incarnation and input/viewport ownership. |
| F085 | Associate observable listeners with host/workspace where evidence allows; distinguish discovered, managed and unknown ownership. |
| F086 | Run a configured service, track readiness/logs, survive UI closure and verify shutdown before releasing managed claims. |
| F087 | Coordinate managed launches across profiles; handle bind races; only claim reservation when a socket is retained/handed off or verified ownership exists. |
| F088 | Route HTTP and WebSocket traffic to the correct host/service; surface unavailable targets and explicit remapping; public aliases require separately specified exposure policy. |
| F089 | Resolve declared dependencies/endpoints, show effective nonsecret configuration and detect unavailable dependencies without silent substitution. |
| F090 | Discover and execute configured scripts with host/workspace identity, output and stop controls; do not introduce excluded saved-command UI. |
| 07-S10 | Fill normal receipts/streams; issue authenticated stop and observe an accurate settlement or explicit unknown state. |
| 07-S11 | Exceed the bounded recovery window; show recovery failure/degradation without replaying input or claiming the process exited. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Saved-command UI and automatic idle hibernation are excluded. Replacing the selected Ghostty core or introducing another terminal renderer is outside this specification; extend the existing renderer for the agreed appearance behavior.

| Feature | Disposition |
|---|---|
| F084 — Saved commands | Not now |

## Further Notes

The [detailed theming specification](../01-foundation/theming.md) defines shared appearance behavior and TH01–TH32 acceptance under D20. The owning feature IDs remain unchanged; appearance acceptance is unverified until the relevant detailed criteria pass.

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
