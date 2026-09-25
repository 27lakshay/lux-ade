# Review a diff and send anchored feedback

Status: ready-for-agent
Type: implementation ticket
Requirements: F074 (daily-use slice), R010, R011
Depends on: desktop profile/workspace and conversation selection; version-checked client requests; durable prompt-send/reconciliation path

Outcome: In the running Electron app, review changed files in the selected Git workspace, select a changed line in one diff hunk, and send feedback to the selected conversation in that same workspace. The feedback text must carry the observed workspace, repository-relative path, staged/unstaged side, diff token, selected line and note. Display the user's anchored feedback in the conversation transcript after admission. This ticket does not complete F074.

## Existing seam

- `Sessions::command` routes `review.*` by `workspace_id` to the daemon's `Review` module (`crates/ade-daemon/src/sessions.rs`). `review.status` returns changed files and a working-state `revision`. `review.diff` accepts `{workspace_id,path,staged}` and returns `header`, `hunks`, `token`, `bytes` and special-file flags (`crates/ade-daemon/src/review.rs`). Its Git output is capped at 4 MiB by `Worktrees::run_input`; oversized output fails explicitly. The GPUI review view proves the protocol exists, but no Electron review surface uses it yet.
- `@ade/client` already has version-checked `requestDaemon`. Electron main uses explicit operation allowlists and validates the selected profile/workspace before relaying requests. `apps/cli` has an `ade request OP JSON_OBJECT` escape hatch for public-protocol inspection; it has no named review commands.
- The desktop's `agent.send` route already binds a conversation to the active profile catalog and owns draft/send reconciliation. Feedback should use that route and its request ID. Direct renderer access to a socket or a second prompt-dispatch path would bypass those checks.

## Narrow implementation

1. Add read-only `review.status` and `review.diff` to a narrow Electron IPC bridge. Validate `workspace_id` against the current profile projection, a repository-relative `path` from the returned status, and `staged` as a boolean. Fence late responses by profile generation and selected workspace. Show a clear non-Git/permission/size error without blocking the conversation.
2. Add a Changes view for the selected workspace. Fetch status on open and explicit refresh; fetch one file diff on selection. Render the bounded hunk text with line numbers and a selected added or context line. Identify the line by path, side, hunk header and line number, plus the returned `review.diff.token` and `review.status.revision`. Do not perform Git mutations in this ticket.
3. Keep a feedback note local until Send. Before sending, force a fresh status and diff for the same workspace/path/side. If either revision or token changed, show **stale diff** and require the user to review again. If still current, compose a readable feedback prompt containing the anchor and note, then use the existing `agent.send`/draft reconciliation route for the selected conversation. Reject selection of a conversation from a different workspace. Never silently clear a pre-existing conversation draft: block this send until that draft is sent, stashed or explicitly replaced.
4. Make pending, accepted and uncertain send states visible using the existing composer behavior. Keep the note and original request ID on an uncertain outcome; never generate a second request ID for a retry.

## E2E acceptance for this slice

- Start real ADE daemon/runtime and Electron with an isolated profile and disposable Git repository. Create a conversation in that workspace using a deterministic provider fixture. Change a tracked text file. In Electron, see the changed file, open its diff, select an added line, write feedback and send it. Assert the transcript and provider fixture receive the same path, line, staged/unstaged side, diff token and note, with one submitted turn.
- Change the file after selecting the line but before Send. Assert the app shows **stale diff**, sends no prompt and preserves the note. Refresh, reselect a line and send successfully.
- Leave text in the conversation's ordinary composer, then attempt to send review feedback. Assert the ordinary draft remains intact and the app requires an explicit choice before sending feedback.
- Switch profile or workspace while a review read is delayed. Assert the old response cannot appear under the new selection or target its conversation. Verify a non-Git folder and an oversized diff fail visibly while the conversation remains usable.
- Use only running-app/public-protocol E2E tests with real ADE processes. No unit or isolated integration tests.

## Remaining F074 work

This slice does not prove the full F074 acceptance of a large, paginated/streamed diff; multiple selected ranges and notes; structured feedback objects; persistence/search of anchors; or atomic stale-anchor validation with prompt admission. The two-read recheck can race with a file change after validation. A later daemon command must bind observed revision/ranges and send admission under one explicit contract, then E2E must exercise that race. Do not mark F074 complete in the requirements register after this slice.
