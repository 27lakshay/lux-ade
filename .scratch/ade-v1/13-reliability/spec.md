# Shared reliability and release requirements

Status: ready-for-agent
Type: specification
Scope: all selected ADE v1 behavior
Implementation status: unverified

## Problem Statement

A feature-rich application is not usable if crashes, stale responses, account
refresh or cleanup silently duplicate actions, lose work or target another host.
These requirements apply across all domain specifications.

## Solution

Make identity, durable admission, execution ownership, bounded delivery, recovery
and observable uncertainty part of every application operation. Prove behavior
through the same external interfaces used by people and agents.

## User Stories

1. **R001.** As a user, I want to keep accepted operations after a daemon failure, so that I can continue without losing or duplicating work.
2. **R002.** As a user, I want to receive consistent retry results, so that I can avoid accidentally performing different work twice.
3. **R003.** As a user, I want to cancel one run without affecting its successor, so that I can continue working after interruption.
4. **R004.** As a user, I want to stop existing execution during overload, so that I can recover control when the application is unhealthy.
5. **R005.** As a user, I want to retain independent work across frontend and daemon restarts, so that I can close or update a view without killing agents.
6. **R006.** As a user, I want to see actual process uncertainty, so that I can avoid treating missing parents as completed work.
7. **R007.** As a user, I want to coordinate physical resources across profiles, so that I can avoid deleting or colliding with another profile's work.
8. **R008.** As a user, I want to know when output recovery reaches its limit, so that I can avoid trusting incomplete terminal or agent output.
9. **R009.** As a user, I want to keep one slow client from degrading other work, so that I can maintain responsiveness during large output.
10. **R010.** As a user, I want to restore a consistent application view, so that I can trust state after crashes and reconnection.
11. **R011.** As a user, I want to avoid stale results after changing context, so that I can see only the selected profile and revision.
12. **R012.** As a user, I want to retain account identity through credential changes, so that I can prevent delayed authentication work from undoing logout.
13. **R013.** As a user, I want to continue active work while plugins update, so that I can upgrade without corrupting old sessions.
14. **R014.** As a user, I want to restore a complete managed backup, so that I can recover after data or upgrade failure.
15. **R015.** As a user, I want to control retention without losing referenced work, so that I can reclaim storage safely.
16. **R016.** As a user, I want to keep preview content separate from application authority, so that I can inspect arbitrary files and websites.
17. **R017.** As a user, I want to keep remote targets stable during connection failure, so that I can avoid accidental local execution.
18. **R018.** As a user, I want to understand failures without exposing secrets, so that I can share useful diagnostic evidence.
19. **R019.** As a user, I want to use many active resources responsively, so that I can work on several tasks at once.
20. **R020.** As a user, I want to run the packaged application independently of development tooling, so that I can use ADE as my daily application.

## Implementation Decisions

1. The daemon is the sole writer of profile core state. SQLite stores current
   state, a durable change feed and an operation journal; full event sourcing is
   unnecessary. No plugin, network or filesystem wait occurs inside a write transaction.
2. Durable desired intent and runtime-observed execution are separate. There is
   no general exactly-once guarantee across external side effects. Receipts and
   reconciliation expose unknown states instead of silently replaying work.
3. Runtime and activation generations fence old callbacks. Resource claims remain
   with execution ownership, not with a window or a lost daemon connection.
4. HostResources coordinates cooperating local runtimes through host-local storage
   and OS guards. It is not a sandbox, distributed scheduler or universal lock on
   external tools; network-mounted SQLite is outside the supported design.
5. Bounded control, history, terminal and transient lanes have distinct durability
   and overflow behavior. Exact budgets are selected through measurement and recorded.
6. Database, feed epoch, wire protocol, provider resume, plugin data and artifact
   compatibility are versioned separately. Code rollback is not automatic data rollback.
7. Agents have user-equivalent application authority. Authentication, attribution,
   target identity and native provider/OS permission semantics still apply.
8. React, xterm and plugin surfaces are replaceable presentation modules; replacing
   them does not grant snapshot or component compatibility automatically.
9. No new unit tests or isolated component/integration tests. Static compilation,
   formatting, linting, architecture checks and Fallow remain separate required checks.

## Testing Decisions

Use real ADE processes from Playwright-driven Electron flows, CLI invocations and
public protocol clients. External deterministic peers model faults at provider or
network interfaces; they do not replace the daemon, database, runtime or SDK with
in-process mocks. Run live primary-provider cases separately and identify which
cases require actual credentials, devices, OS permissions or signed release artifacts.

Prior art includes prototype transactional feed/migration, draft-close and terminal
ordering cases; Orca resource/credential/descendant cases; Paseo interrupt/question
cases; t3code client cursor/stream-budget cases; and OpenCode inbox/run-coordination
cases. Reexpress those scenarios through the approved E2E interfaces.

| Requirement | Required end-to-end evidence |
|---|---|
| R001 | Crash around intent commit, dispatch, external acknowledgement and settlement; return recorded outcomes or explicit unknown status and reconcile without blind replay. |
| R002 | Retry identical operation IDs/payloads and then altered payloads; observe deduplication and strict conflict even after reconnect. |
| R003 | Race cancel, cleanup and a new admitted wake/turn; verify incarnation fencing on commands, async callbacks and streams. |
| R004 | Saturate ordinary commands, receipts and output; fill a disposable test volume; reject new unsafe admission while emergency authenticated stop remains available or reports its actual failure. |
| R005 | Close/reload renderer and restart compatible daemon during real execution; runtime identity and claims survive within the declared recovery window. |
| R006 | Exercise ignored signals, reparented/escaped fixture descendants and stale process identity; do not label exit or release resources without appropriate evidence. |
| R007 | Race claims across profiles and path aliases/replacement; corrupt or migrate a disposable registry with live owners; fail closed for unsafe new work without forgetting ownership. |
| R008 | Exhaust bounded runtime spool and reconnect history; show explicit degradation/resnapshot requirements without fabricated process exit. |
| R009 | Use slow/disconnected protocol clients alongside fast clients and active providers; bound item/byte queues and preserve control responsiveness. |
| R010 | Interrupt client projection/cursor persistence; reconnect with retained/expired cursors and changed history epoch; produce a consistent snapshot/catch-up state. |
| R011 | Delay history/search responses, then delete/rewind/switch profile; late results cannot resurrect or cross-associate data. |
| R012 | Race refresh/readback/logout and external CLI replacement; preserve logout generation and revalidate capabilities without fallback to a different identity. |
| R013 | Update code and data schema with a leased old worker; keep compatible data/artifacts or require drain; late old cleanup cannot remove new registrations. |
| R014 | Back up during writes, restore database/blobs/manifests and validate through public reads; disclose excluded private/native data and reject unsupported schemas without mutation. |
| R015 | Run retention concurrently with blob finalization, active execution and backup; preserve live/in-flight/referenced artifacts and unresolved resource claims. |
| R016 | Load adversarial fixture file/page/frame/popup content; no application bridge or cross-profile data access is exposed by the viewer integration. |
| R017 | Disconnect/revoke a host and change local focus; commands fail or reconcile against the original remote identity, never substitute a local host/device/account. |
| R018 | Collect bounded correlation logs and diagnostic exports; verify credential fixture values are redacted and raw transcripts are excluded by default. |
| R019 | Run provisional 10-agent/20-terminal/5-browser fixture plus large history/diff, slow consumer and idle phases; record p95 echo/admission, whole-process-tree memory and bounded queues without asserting unmeasured wins. |
| R020 | Launch packaged macOS artifact in a clean environment; find declared native/provider resources, handle incompatible live owners safely and exercise primary daily-use E2E flows. |

Use disposable resources and test-owned process records for fault injection. Never
kill or remove personal work to exercise recovery. Preserve first-attempt failure
artifacts; retries do not erase the failure. Native UI checks that the chosen
runner cannot automate require recorded manual/platform evidence, not a fake pass.

## Out of Scope

Hostile-plugin containment, arbitrary-process containment, unlimited lossless
spooling, automatic cross-host migration and proven superiority over every reference
project. Advanced orchestration recovery is excluded, but ordinary operation and
process recovery above is mandatory.

## Further Notes

Performance numbers in the architecture are provisional targets, not measured
results or universal guarantees. Hardware and workload must accompany evidence.
The initial audit host was an M4 with 24 GiB RAM; it is not an established minimum
supported machine. Compare reference products only on equivalent supported work.
