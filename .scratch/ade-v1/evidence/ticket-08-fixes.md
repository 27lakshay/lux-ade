# Ticket 08 fixes: daemon and SDK half

Status: done, one E2E flake classified as pre-existing
Branch: `claude/agent-a7d184619e1f123fe` (worktree
`~/work/worktrees/lux-ade/claude-agent-a7d184619e1f123fe`), rebased once onto `main` at
`95b96a8`. Written 2026-09-29.

## Results

| Gate | Result |
|---|---|
| `pnpm check:static` on rebased HEAD | passed: 862 Rust tests, 246 pure JS tests, 310 renderer tests |
| Full `pnpm test:e2e:protocol:only`, 6 workers, before the rebase | 975 passed, 15 skipped, 1 failed |
| The failure, run alone | `conversations2/draft-history.spec.ts:22` fails 2 of 5 runs alone on this branch, and 1 of 8 on the baseline daemon and SDK (`66bf5a2`) |

The one failure is a pre-existing race in the spec, not a regression. The spec kills the daemon
right after `agent.send` returns; when the kill lands before the provider's `turn/start`, the
Conversation restarts `interrupted` ("Daemon stopped before prompt delivery was confirmed"), and
`waitForIdle` times out. It fails on the baseline too.

## Commits

| Commit | Task |
|---|---|
| `3c44a2a` | C1, C2: Conversation-in-a-terminal path and `legacy_ambient` removed |
| `9a79a6e` | C3: Ghostty snapshots only as base64 |
| `960cdff` | C4, C5: review `migrate_jobs`; ownership records need their identity |
| `b28b8fe` | Coordinator request: `hooks-auth/auth.spec.ts` compares only the terminal set |
| `6c6ed32` | C6: `layout.replace` removed |
| `fee88db` | C7: `agent.send_review` removed; CLI `draft get` and `draft save` added |
| `9523dcf` | C8: closed terminal enums in the SDK, every error coded, old-row serde defaults removed |
| `440fcb3` | A6: `worktree.*` take `project_id` |
| `053579b` | C9: one global `--operation-id` |
| `5df9a34` | A1: `review_file_unavailable`; main's review checks moved to the daemon |
| `87c43e9` | A2: `window.claim` |
| `29d7f05` | A3: `create_worktree` `show_in`; `window.show_workspace` replies with the layout |
| `c597c7e` | A4: `workspace_worktree_operation_changed` frame; SDK `settleWorktreeOperation` |
| `5c3903e` | A5: one `rebind.list` |
| `cc99049` | B1: SDK owns the draft owner ID |
| `678a145` | B2: `SendPipeline.send` and `.retry` |
| `c1647a6` | D: protocol E2E for the uncovered operations |

## Contract changes

New operations and frames:

- `window.claim {window_id, claimed?}` (idempotent command), reply `window`.
- `rebind.list {}` (query), reply `rebind_catalog {lifecycle, repositories, workspaces}`.
- Frame `workspace_worktree_operation_changed {operation, boot_id, revision}`.
- `workspace.create_worktree` gains `show_in`.
- `window.show_workspace` replies `{type: window, window, layout}`.
- New refusal code `review_file_unavailable` (recovery `refresh_changes`; CLI exit 34).

Removed: `agent.send_review`, `layout.replace`, `worktree.rebind.list`, `repository.rebind.list`,
`workspace.rebind.list`, the review fields on `draft.send.prepare` and send intents,
`terminal_snapshot_bytes`, `TerminalRecord.conversation_id`, `TerminalKind::Conversation` and the
`conversation_in_terminal` remove blocker.

Renamed: `worktree.*` request and reply `repository_id` to `project_id`. `account_context` is now a
closed enum, with `legacy_ambient` renamed to `ambient`.

Every daemon error frame now carries a code. A refusal without a more specific code is `daemon`.

## CLI changes

- `--request-id` that carried an operation ID is gone; the global `--operation-id` goes before or
  after the command, once. Commands that need a retained ID refuse to run without it.
- `conversation send`, `queue add` and `attachment import` keep `--request-id`, because it fills
  their `request_id` field.
- Orchestration's and runs' own `--operation-id` options are now the global one.
- Output echoes `operation_id` instead of `request_id`, and receipt lookups name `OPERATION_ID`.
- New commands: `window claim`, `rebind list`, `draft get` and `draft save`.
- Removed commands: `layout replace`, `git feedback-send`, and the three `rebind-list` commands.

## Desktop call sites touched

- `main/review.ts`: fence only.
- `main/windows.ts`: claim.
- `main/layouts.ts`: replace IPC removed; show returns the layout.
- `main/workspace-actions.ts`: `show_in`, SDK wait.
- `main/workspace-actions-core.ts`: blocker wording.
- `main/workspaces.ts`: `rebind.list`, `project_id`.
- `main/conversations/send-pipeline.ts` and the `ipc.ts` send/retry block.
- `main/index.ts`: owner ID from the journals, 2 lines.
- `preload/layouts.ts`, `shared/ipc.ts`, `shared/bridge/layouts.ts`, `shared/bridge/conversations.ts`.
- Renderer: `sidebars/workspace-actions.ts`, `model/layout-sync.ts`, the dev layout double and test
  fixtures.

## Open or uncertain

- The SDK `Workspace` fields (`project_id`, `kind` and the others) are still optional for
  hand-built fixtures, like the catalog lists were. Left as they are.
- The desktop was not run in Electron. Only renderer tests and typecheck cover the claim, `show_in`
  and send changes.
- The CLI's `workspace create-worktree --wait` still polls. It has no feed client.
- These stay as they were: the hook event payload for worktrees (`repository_id`), orchestration's
  `repository_id`, and `lifecycle_id` in the worktree operation record.
