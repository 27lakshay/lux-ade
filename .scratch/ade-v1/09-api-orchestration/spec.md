# API, CLI and agent coordination

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need agents and command-line tools to operate ADE itself and coordinate work with the same semantics as the UI.

## Solution

Expose one versioned command/query/subscription surface and use it for CLI, SDK, delegation and agent communication.

## User Stories

1. As a user, I want support for Complete application command API, so that I can let agents perform the same actions as me. **F101**
2. As a user, I want support for CLI support, so that I can operate ADE from shells and automation. **F102**
3. As a user, I want support for Client SDK, so that I can build integrations without UI internals. **F103**
4. As a user, I want support for Delegation, so that I can assign work to another agent. **F104**
5. As a user, I want support for Parallel runs and comparison, so that I can explore multiple approaches. **F105**
6. As a user, I want support for Parent and child tracking, so that I can understand delegated work. **F106**
7. As a user, I want support for Agent messages, waits and questions, so that I can coordinate work across agents. **F107**
8. **09-S08.** As a integration author, I want to receive a conflict when I reuse an operation ID for different work, so that I can detect retry bugs.
9. **09-S09.** As a user, I want to keep new work safe from old cancellation callbacks, so that I can continue after an interrupted run.

## Implementation Decisions

1. Agents have the same application authority as the user. Authenticate and attribute callers; apply the same target validation, conflict and lifecycle rules to every caller.
2. Commands carry stable identity, canonical payload fingerprint and required preconditions. The daemon commits desired intent/outbox before dispatch; runtime receipts report actual evidence.
3. Fence attempts, callbacks and cancellation with runtime/worker/turn generations. Unknown external effects are reconciled, never blindly retried for an exactly-once claim.
4. CLI structured output and errors support headless automation. The framework-neutral SDK implements consistent projection/cursor application and transport adapters.
5. Delegation explicitly binds account/provider/workspace/host/context. Parallel work does not imply isolated files or automatic merging; parent/child relationships persist independently of process lifetime.
6. Waits and questions have explicit target, completion, timeout and cancellation semantics. Late responses cannot settle a replacement question.
7. When storage cannot accept durable commands, reject new launches but retain authenticated emergency stopping of existing execution; reconcile its outcome when storage recovers.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Command admission, client SDK, CLI, runtime, delegation and messaging.

Prior art: OpenCode durable inbox/run coordinator; prototype receipt saturation and control queue; Paseo question retries. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F101 | Invoke core actions through one versioned authenticated interface; preserve authority, target identity, idempotency and the same lifecycle rules as UI actions. |
| F102 | Discover commands, target host/profile/workspace explicitly, receive structured output and stable error/exit behavior, and control existing GUI-created work. |
| F103 | Connect a headless consumer, issue commands and subscribe through generated contracts without React/Electron dependencies. |
| F104 | Create a child with explicit provider/account/workspace/context; report admission and running state without assuming completion. |
| F105 | Launch independent runs with explicit shared/new workspaces; compare outcomes and changes without automatically merging conflicting edits. |
| F106 | Persist relationships and statuses across reconnect/restart, including failed/unknown children and independent execution lifetimes. |
| F107 | Deliver identified messages, wait for bounded conditions and answer questions once; preserve timeout/cancellation semantics and distinguish unavailable peers. |
| 09-S08 | Submit the same ID/payload twice and then change payload; observe deduplication followed by explicit conflict. |
| 09-S09 | Race cancellation cleanup with a new admitted turn; old callbacks must not stop or settle the successor. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

DAGs, advanced orchestration recovery, specialist discovery, schedules, heartbeat and conditional automation are excluded. Ordinary reliable operation recovery is mandatory.

| Feature | Disposition |
|---|---|
| F108 — Task DAG orchestration | Not now |
| F109 — Advanced orchestration recovery engine | Not now |
| F110 — Specialist discovery | Not now |
| F111 — Scheduled automation | Not now |
| F112 — Heartbeat automation | Not now |
| F113 — Conditional automation | Not now |

## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
