# Conversations, history and attention

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users lose context when messages, drafts, tools and native histories behave differently across agents or reconnects.

## Solution

Provide a durable structured conversation view with explicit queue, draft, history, compaction and attention behavior.

## User Stories

1. As a user, I want support for Structured conversations, so that I can understand messages, tool calls and results. **F031**
2. As a user, I want support for Attachments and media, so that I can send supported context beyond text. **F032**
3. As a user, I want support for Prompt context capture, so that I can include files, terminal output, diffs and browser context. **F033**
4. As a user, I want support for Message queues, so that I can prepare follow-up work during execution. **F034**
5. As a user, I want support for Steering active runs, so that I can redirect a running agent when supported. **F035**
6. As a user, I want support for Draft recovery, recall and stash, so that I can avoid losing unfinished prompts. **F036**
7. As a user, I want support for Slash commands and skills, so that I can invoke reusable agent instructions. **F037**
8. As a user, I want support for Approvals and questions, so that I can answer an agent's pending request once. **F038**
9. As a user, I want support for Conversation and file rewind, so that I can return to a supported earlier point. **F039**
10. As a user, I want support for Context compaction, so that I can continue long sessions within provider limits. **F040**
11. As a user, I want support for Combined history, so that I can find work across supported agents. **F041**
12. As a user, I want support for External session import, so that I can bring existing agent work into ADE. **F042**
13. As a user, I want support for Work search, so that I can locate conversations and related resources. **F043**
14. As a user, I want support for Snoozing, so that I can temporarily defer attention to work. **F046**
15. As a user, I want support for Usage analytics, so that I can review reported agent usage. **F049**
16. As a user, I want support for History export and backup, so that I can retain and recover my work. **F050**
17. **03-S17.** As a user, I want to retain my place during streaming and history loading, so that I can read without unexpected jumps.
18. **03-S18.** As a user, I want to distinguish connected from caught up, so that I can know when displayed state is current.

## Implementation Decisions

1. Persist submitted messages as shared state. Drafts are owned by client and conversation, with explicit recovery/transfer instead of implicit concurrent editing.
2. Normalize history into core-readable envelopes containing stable identity, type/schema version, status, summary and attachment references while retaining native provenance.
3. Commit operation intent and durable dispatch work before external effects. Same operation ID and payload returns a known outcome; a different payload with the same ID conflicts.
4. Keep per-conversation conflicting transitions ordered. Cancellation requested, accepted, stopped and idle are distinct; old callbacks cannot settle successor runs.
5. Combined history is an active-profile view/search capability, including explicitly connected resources as authorized. Do not silently aggregate private data from unrelated profiles.
6. History pagination and live-feed cursors are distinct. Rewind, deletion and profile change invalidate late reads. Expired feed positions require a fresh snapshot.
7. Snoozing affects attention only. It persists a due time and becomes visible when due or when ADE next opens; it does not add excluded scheduled agent execution.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Conversation commands, client projection, drafts, history, search, blobs and attention state.

Prior art: Prototype draft revisions/close fences and transactionally persisted feed positions; t3code interrupted cursor application; OpenCode durable inbox coordination. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F031 | Stream text and structured tool events; preserve ordering and readable fallback for unknown content types after restart. |
| F032 | Attach supported media; reject unsupported type/size before dispatch; restore attachment references and show missing-file errors. |
| F033 | Capture a selection from each supported surface; preserve source identity and preview exactly what is sent. |
| F034 | Queue messages, inspect and remove pending entries, restart the daemon, and dispatch accepted entries without duplication. |
| F035 | Steer a compatible active run and observe native acknowledgement; an unsupported provider reports its limitation without mislabeling a queued message. |
| F036 | Restore a draft after a window crash, recall/stash text and context, and transfer a draft explicitly without another client overwriting it. |
| F037 | Discover and invoke supported commands/skills with their arguments; surface adapter-specific invocation and missing-resource failures. |
| F038 | Render native choices, submit one answer, retry a failed delivery safely, and reject a late or conflicting answer after settlement. |
| F039 | Preview the affected conversation/files; perform supported rewind; invalidate stale history pages and report partial or unsupported restoration honestly. |
| F040 | Request or observe native compaction; preserve its provenance and retained context; show failure without claiming a new context state. |
| F041 | Search/read normalized history across providers in the active profile; retain native session references and no implied cross-provider continuation. |
| F042 | Import a supported native session twice without duplicates; retain source provenance and distinguish read-only import from resumable sessions. |
| F043 | Search retained indexed content, open the correct resource, and remove deleted records from results; show indexing lag explicitly. |
| F046 | Snooze an item until a chosen supported time, restart ADE, and restore its attention state when due; do not stop work or launch scheduled agent tasks. |
| F049 | Aggregate available usage by time/provider/account with units, source and missing-data indicators; do not invent billing values. |
| F050 | Export readable history and create/restore a consistent managed backup; verify blobs and disclose excluded credentials/native/private-plugin data. |
| 03-S17 | Prepend history and expand delayed content while reading an older message; preserve the visible anchor. |
| 03-S18 | Reconnect with retained and expired cursors; expose catch-up and snapshot completion correctly. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Task organization dashboard/pins/labels/archive UI, automatic settlement and hibernation are excluded. Conversation/file rewind only where supported.

| Feature | Disposition |
|---|---|
| F044 — Task pins, labels, ordering and archive UI | Not now |
| F045 — Dashboard | Not now |
| F047 — Automatic settlement | Not now |
| F048 — Idle hibernation | Not now |

## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
