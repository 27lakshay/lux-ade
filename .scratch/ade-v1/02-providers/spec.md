# Providers, accounts and capability contracts

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need reliable primary agents and multiple accounts without credentials, native sessions or permission meanings leaking between them.

## Solution

Ship Claude Code, Codex and Oh My Pi through the same provider extension contract, with explicit capabilities and account identity.

## User Stories

1. As a user, I want support for Claude Code, Codex and Oh My Pi, so that I can use primary agents reliably. **F021**
2. As a user, I want support for Additional bundled providers, so that I can use supported agents beyond the primary three. **F022**
3. As a user, I want support for Provider plugins, so that I can add a new agent without changing core modules. **F023**
4. As a user, I want support for Generic ACP and custom executable adapters, so that I can connect compatible agents through standard adapters. **F024**
5. As a user, I want support for Multiple accounts, so that I can keep several accounts for the same provider. **F025**
6. As a user, I want support for Explicit in-conversation account switching, so that I can change accounts when the provider supports it. **F026**
7. As a user, I want support for Provider setup, authentication and readiness, so that I can know whether an agent can run. **F027**
8. As a user, I want support for Model, reasoning and permission capabilities, so that I can choose options the provider actually supports. **F028**
9. As a user, I want support for Agent presets, so that I can reuse model and instruction settings. **F029**
10. As a user, I want support for Quota and limit visibility, so that I can understand provider availability. **F030**
11. **02-S11.** As a user, I want to remain logged out after a delayed credential refresh, so that I can trust account removal.
12. **02-S12.** As a user, I want to see unknown provider outcomes honestly, so that I can avoid duplicate external effects.

## Implementation Decisions

1. Bundled provider workers use the public provider contract. Do not add hidden privileged paths merely to make a primary provider work.
2. Pin account identity, execution host, provider installation, adapter version and launch configuration revision per execution context. Native process sharing scope is adapter-declared.
3. Credentials can refresh while account identity stays fixed. Serialize refresh/readback and fence late writes with a logout generation. Keep secret references rather than raw credentials in application records.
4. Provider acknowledgement and execution settlement are different. Preserve native steering, queue, autonomous activity, asynchronous question and permission-grant semantics.
5. Version native resume handles and preserve native IDs/provenance. Imported history is not automatically resumable. Unknown outcomes need reconciliation, not blind replay.
6. Externally managed executables require fresh compatibility checks. Managed adapter/runtime artifacts remain pinned while active work leases them.
7. Additional bundled provider roster remains unspecified. The primary three are mandatory; do not mark additional-provider coverage complete through a generic adapter alone.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Provider workers, runtime, accounts, capability discovery and conversation commands.

Prior art: Paseo async-question and interrupt/restart cases; Orca native credential readback/logout cases; t3code provider-specific native homes. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F021 | Each real provider passes launch, prompt, tools, questions/approvals where supported, cancellation, account selection and supported resume flows. |
| F022 | Declare a named supported roster before shipping this item; each listed adapter passes the published capability matrix and actual-provider E2E flows. |
| F023 | Install a separate provider package through the normal plugin path; discover capabilities, run a turn and recover readable history after disabling it. |
| F024 | Connect a conforming ACP peer and a declared executable protocol; unsupported operations fail with capability errors rather than fabricated parity. |
| F025 | Run conversations under two accounts; verify account-specific native state and no credential or session crossover. |
| F026 | Switch using an adapter-declared operation; retain provenance, disclose continuity limits and reject unsupported switching without silently creating a different session. |
| F027 | Exercise missing executable, invalid credentials, incompatible version and ready states; expose actionable errors and revalidate after an external CLI update. |
| F028 | Select supported settings; refresh capabilities; reject stale unsupported choices and preserve once-only versus persistent permission meanings. |
| F029 | Create and apply a preset; show the resolved settings and capability conflicts without changing account identity implicitly. |
| F030 | Display reported quota/reset data with source and freshness; show unavailable when unknown; do not silently switch account or model on exhaustion. |
| 02-S11 | Log out during refresh; a late completion must not restore the account. |
| 02-S12 | Disconnect after provider acknowledgement but before local settlement; reconcile without redispatching the prompt. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Cross-provider session continuation and implicit account/model fallback are not promised. No universal capability parity.


## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
