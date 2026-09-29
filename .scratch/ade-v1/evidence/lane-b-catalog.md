# Lane B: catalog and workspace operations (daemon-authority ticket 03)

Status: built, review fixes applied (2026-09-29). Branch `claude/agent-a322b89d84c966f98`.

## Review fixes (2026-09-29)

| Finding | Fix | Evidence |
|---|---|---|
| 1. A busy repository failed create and delete, and a delete had already removed the workspace | Busy refusals are typed `lifecycle_busy`; a step waits on them. A delete also waits before removing the workspace while the repository is busy | E2E "two deletes sent back to back…", "while another worktree sets up, a creation and deletions wait…" |
| 2. One erroring operation stalled the tick; a reused ID errored forever | The tick logs per operation. A step error fails its operation and restores a removed workspace; `restored()` cannot fail the step. A lifecycle-used ID is refused at admission | E2E rename failpoint, reused-ID conflict, restore-refused failpoint |
| 3. Tree blockers checked only at admission | Checked again inside the Workspace step, under `worktree_steps`, before `remove_from_ade` | E2E: a tree dirtied while the delete waited is refused, workspace and file kept |
| 4. Restored workspace comes back empty | The failed state's `error` says so (or that the restore failed); contract docs say it | E2E remove_tree failpoint |
| 5. Unread parsed every message | `conversation_news.news_sequence` kept by every message writer, recounted on rewind, backfilled by the migration | Unit test; load numbers below |
| 6. Stuck terminal retried every tick for 10 s each | `TerminalsStillStopping` retried with backoff from 1 s, four attempts, then the operation fails and restores | Not covered by E2E: no fixture keeps a shell from stopping |
| 7. `worktree.repository` inserted catalog rows | Lookup only; a workspace opening later takes the lifecycle's ID | Unit test; E2E "registering a repository with the lifecycle adds nothing…" |
| 8. Overlong review prompt got the queue's generic error | `review_prompt_too_long` | E2E 16 notes of 4000 bytes |

Load spec p95 admission (sustained / idle / after recovery):

| Run | Before fixes | After fixes |
|---|---|---|
| Alone | 143.7 / 72.2 ms | 108.3 / 48.7 / 49.7 ms |
| Two load runs at once (`--repeat-each 2`, 2 workers) | not measured; the full suite with 2 workers failed at 264 and 307 ms | both pass; one run 163.1 / 76.8 / 53.5 ms |

E2E after the fixes: `workspaces/` (including the 6 new busy-spec tests), `review/feedback`
(4), and a wide area run (workspaces, conversations, conversations2, review, worktrees,
context, accounts-rewind, catalogs, orchestration, profiles, backup): 884 passed, 1 failed,
14 skipped. The failure, `conversations2/draft-history` "a discard and a send are recorded
in history once…", fails about one run in six alone: it SIGKILLs the daemon right after a
turn's send, and the turn is sometimes still running, so it ends `interrupted`. It does not
touch this lane's code; it was not run on `main` to compare.

## Results (first build)

| Check | Result |
|---|---|
| `pnpm check:static`, per commit | Commits 1 to 3 passed on the final rebase. Commit 4 passed on the previous rebase; since then only one parity-spec line changed (format, typecheck and lint pass) |
| Rust tests in the gate | 867 passed, 4 skipped |
| Full protocol E2E (`ADE_E2E_WORKERS=2`), before the last rebase | 871 passed, 3 failed, 14 skipped. See the failures below |
| Lane specs | `workspaces/projects` 3, `workspaces/worktrees` 4, `conversations/attention` 2, `review/feedback` 3, `profiles/settings` 2: all pass |
| `orchestration/parity`, `hooks-auth/auth` after the fix | 7 passed |
| Load spec alone (`ADE_E2E_WORKERS=1`) | Passed: sustained p95 admission 143.7 ms, idle 72.2 ms |

Failures in the full run and what they were:

- `orchestration/parity`: it needs a sample per contract domain; `settings` had none. Fixed in the settings commit.
- `hooks-auth/auth`: a terminal record read `running` instead of `not_started`. It passed on rerun. It does not touch this lane's code, but it is not proven unrelated.
- `load/load`: sustained p95 admission 264 ms, then 307 ms, against a 250 ms target, with a second worker running. Alone it passes at 144 ms. The README says to run it alone. This lane adds work per feed frame (four small reads to present a Conversation) and a 500 ms facts tick, so part of the gap may be this lane's.
- `files-git/local-git` (branches, stashes and merges) failed once in a partial run and passed 12 times on repeat.

## What was built

| Operation | Tier | CLI |
|---|---|---|
| `workspace.create_worktree` | effect | `workspace create-worktree PROJECT_ID NAME [--base REF] [--wait]` |
| `workspace.delete_worktree` | effect | `workspace delete-worktree WORKSPACE_ID [--delete-merged] [--wait]` |
| `conversation.mark_seen` | idempotent | `conversation mark-seen ID [--through SEQUENCE]` |
| `review.feedback.send` | effect | `review send CONVERSATION_ID (--anchors JSON --note TEXT \| --feedback JSON) [--window ID]` |
| `settings.get` | query | `settings get` |
| `settings.set` | idempotent | `settings set KEY VALUE ...` |

New feed frame: `settings_changed`. New error codes (CLI exit): `worktree_delete_blocked` (24),
`project_not_found` and `project_not_repository` (25), `unknown_setting` (26),
`review_anchor_stale` (27), `draft_not_empty` (28).

Catalog changes:

- `projects: [{id, kind, name, root}]`, kind `repository` or `folder`.
- Workspace: `project_id` (never empty), `kind`, `branch`, `default`, `ade_owned`.
- Conversation: `attention`, `unread`, `parent_conversation_id`, `group_id`; derived on every reply and frame, never stored.
- Kept as deprecated aliases for one release: `Catalogue.repositories` and `workspace.repository_id` (still null for a folder). The SDK builds `projects` from them for an older daemon.

Migration: `store::projects::migrate`, under a provisional `if version < 20` (lanes C and A hold 18 and 19). Backup coverage schema is 20. Lane A's test `the_migration_replaces_the_prototype_window_table` now rolls back to before the layouts migration, since this one follows it.

## Decisions for the coordinator

1. **Unread follows messages, not `updated_at`.** Unread means a message the person did not write, newer than the seen mark. `updated_at` moves on daemon bookkeeping; even a graceful restart marked Conversations unread. `mark_seen.through` is a message `sequence`. Existing Conversations and first history imports start read.
2. **`reduced_motion` has three values** (`system`, `on`, `off`), as the renderer has. Typography and keybindings are not keys yet.
3. **`review.feedback.send` takes two shapes**: `anchors` with one `note` (ticket shape) or `feedback` with a note per anchor. Several anchors with one note repeat the note under each. The draft check needs `window_id`; without it there is none, because drafts belong to windows.
4. **Queued prompts carry their review feedback** (new `queued_prompts.review_feedback` column), so the delivered message keeps it for `review.feedback.search`.
5. **`review_anchor_stale` now also types `agent.send_review`'s stale-diff refusals**, with the same messages.
6. **Branch watching is a 500 ms poll of each checkout's `HEAD` file**, read without a Git child, not a file-system watcher.
7. **A folder workspace refused by `delete_worktree` uses a new blocker kind `not_a_worktree`.** `active_work`, `setup_incomplete` and `teardown_incomplete` do not block, as the desktop filtered them; `active_work` still blocks for a workspace already removed from ADE.
8. **A failed tree removal restores the workspace** it removed from ADE.
9. **Lifecycle ID unification runs at daemon start.** A repository that needs a rebind, runs an operation, or whose lock a surviving supervisor holds keeps its old ID until a later start.

## Not done or unproven

- The desktop still uses its own chain; ticket 07 switches it.
- The load-spec regression under two workers is not measured against `main`.
- `worktree.cleanup` and `worktree.carry` accept aliased IDs through the same path, but only `get`, `operation`, `create` replay and `repository` were tested with an alias.
