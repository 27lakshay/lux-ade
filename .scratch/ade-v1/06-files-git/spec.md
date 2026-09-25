# Files, diffs and Git

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need to inspect and act on agent changes without hidden destructive side effects or requiring a full built-in editor.

## Solution

Provide read-only file previews, revision-aware diff feedback and explicit Git commands on the selected execution host.

## User Stories

1. As a user, I want support for File explorer and search, so that I can inspect workspace contents. **F071**
2. As a user, I want support for File previews, so that I can inspect supported files without an editor. **F073**
3. As a user, I want support for Diff review and agent feedback, so that I can review changes and send precise feedback. **F074**
4. As a user, I want support for Ordinary Git operations, so that I can manage changes without leaving ADE. **F075**
5. As a user, I want support for Multiple forge support, so that I can use repositories hosted by different services. **F078**
6. **06-S06.** As a user, I want to see changed preconditions before destructive file operations, so that I can avoid losing newer edits.

## Implementation Decisions

1. File and Git operations resolve against stable workspace/host identity and appropriate expected revisions. Display paths without treating them as permanent identities.
2. Use bounded paginated/streamed file and diff handling. Heavy parsing/highlighting must not block the application renderer; preserve cancellation and stale-result invalidation.
3. Untrusted file previews and HTML must not inherit application bridges or trusted plugin authority.
4. Agent feedback references the observed diff revision and selected ranges. Expose stale anchors rather than silently applying comments to different code.
5. Git operations use the same authorized command interface as UI/CLI/agents. Handle authentication, conflicts and interrupted remote effects explicitly.
6. Forge coverage is a named compatibility matrix for ordinary repository operations. It does not add excluded PR management or issue-tracker integrations.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: File queries, preview presentation, diff review, Git commands and feedback context.

Prior art: Prototype review services and bounded review requests; t3code/OpenCode large-diff presentation patterns. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F071 | Browse and search on the execution host; handle symlinks, large files, permission failures and changed paths without freezing the UI. |
| F073 | Open supported text/media previews, show limits and unsupported formats, and prevent untrusted content from receiving application authority. |
| F074 | Display a large diff, anchor notes to a revision, send selected feedback to the agent and flag stale anchors after changes. |
| F075 | Stage, unstage, commit, push, pull, branch, stash, merge and discard through explicit commands; show conflicts and changed working-state preconditions. |
| F078 | Declare supported forge/auth coverage; verify basic repository and remote workflows for each without implying excluded PR/issue integrations. |
| 06-S06 | Change files after a discard/restore preview; reject stale execution or require a fresh explicit decision. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Built-in editor, PR management/advanced review, issue integrations and per-agent change attribution are excluded.

| Feature | Disposition |
|---|---|
| F072 — Built-in code editor | Not now |
| F076 — PR creation and management | Not now |
| F077 — Advanced PR status and review | Not now |
| F079 — Issue tracker integrations | Not now |
| F080 — Change attribution | Not now |

## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
