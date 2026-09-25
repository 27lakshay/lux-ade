# Desktop notifications and activity

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need to notice completion, failures and requests without watching every conversation.

## Solution

Create durable activity identities and deliver local notifications with preferences, deduplication and navigation.

## User Stories

1. As a user, I want support for Desktop notifications, so that I can notice actionable work. **F114**
2. As a user, I want support for Activity feed, so that I can inspect relevant application events. **F117**
3. **10-S03.** As a user, I want to avoid repeat notifications when I reconnect, so that I can trust the activity feed.

## Implementation Decisions

1. Activity is application state; notification presentation is a client/OS capability. A toast alone is not a durable notification system.
2. Route v1 desktop delivery to an available client with deduplication. Preserve event/resource identity for later multi-client routing without requiring push infrastructure.
3. Respect notification preferences, source profile and snoozed attention state. Do not use a notification action to silently change account or execution host.
4. Deep navigation resolves stable resource identity and handles removed/unavailable targets. Feed entries remain readable when a plugin is disabled.
5. OS delivery failures and permission denial remain visible through the activity interface. Do not claim an OS notification was delivered merely because it was requested.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Durable activity, desktop notification adapter, attention preferences and navigation.

Prior art: Prototype bounded diagnostics/identity patterns; reference desktop notification integration. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F114 | Notify for selected completion/failure/input events, respect preferences and navigate to the correct resource; deduplicate durable activity on reconnect. |
| F117 | Show durable activity with origin/status, filter/open targets and preserve readable entries when extensions disappear. |
| 10-S03 | Reconnect after a recorded activity; show the entry once and do not duplicate previously handled desktop delivery. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Push, cross-client deduplication product, dictation, conversational voice and ongoing widgets are deferred or excluded as recorded in the register.

| Feature | Disposition |
|---|---|
| F115 — Push notifications | Design now, ship later |
| F116 — Cross-client notification coordination | Design now, ship later |
| F118 — Ongoing widgets | Not now |
| F119 — Dictation | Design now, ship later |
| F120 — Conversational voice | Design now, ship later |

## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
