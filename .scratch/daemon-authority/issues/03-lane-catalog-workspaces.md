# 03 — Lane B: catalog and workspace operations

Status: closed
Type: task
Label: wayfinder:task
Assignee: coordinator (lane agent)
Blocked by: [01](01-phase-0-foundation.md)

Give the catalog the flat model's fields and turn the desktop's chained workspace calls into
single daemon operations.

## Build

1. **One project identity.** Every workspace belongs to a project; a plain folder becomes a
   project of kind `folder`. The catalog's `repositories` becomes `projects`
   (`id`, `kind`, `name`, `root`). The worktree lifecycle uses the same project ID: migrate its
   `repository_…` rows onto the catalog ID by Git common directory, and accept the old ID as an
   alias in lookups so existing receipts still resolve. `workspace.repository_id` becomes
   `project_id`, never null.
2. **Workspace attributes.** `kind` (`primary_checkout`, `linked_worktree`, `folder`), `branch`
   (HEAD branch or null when detached or not Git), `default` (the daemon's own workspace),
   `ade_owned` (the lifecycle created it). Refresh `branch` on open, after ADE's own Git
   operations, and when the checkout's `HEAD` changes (watch the worktree's own `HEAD` file).
3. **`workspace.create_worktree`** (effect command): `{operation_id, project_id, name, base?}`.
   Creates the worktree through the lifecycle (setup hooks included), opens it as a workspace
   named `name`, and records the outcome on the receipt. The reply carries the operation's
   state; the new workspace appears in the catalog when it is ready. Progress is readable through
   the existing operation query.
4. **`workspace.delete_worktree`** (effect command): `{operation_id, workspace_id,
   delete_branch?: "keep" | "merged"}`. Checks the workspace's blockers and the tree's cleanup
   blockers inside the operation, removes the workspace from ADE, then removes the tree. Refuses
   with `worktree_delete_blocked` and typed blockers (the cleanup plan's kinds plus the
   `workspace.remove` blockers) before changing anything.
5. **Conversation fields.** `attention`: `running` (running, responding, streaming, starting,
   cancelling), `needs_you` (a pending question or approval, or waiting), `error` (error,
   unavailable, disconnected), otherwise `idle`. `unread`: true when the conversation changed
   after the profile's `seen_at` for it; `conversation.mark_seen` (idempotent) clears it. Put
   `parent_conversation_id` and `group_id` from orchestration on the catalog record.
6. **`review.feedback.send`** (effect command): `{operation_id, conversation_id, anchors,
   note}`. The daemon builds the prompt that `apps/desktop/src/main/review.ts`
   (`reviewPromptText`, `reviewBatchPrompt`) builds today, and queues it.
7. **Settings.** `settings.get` (query) and `settings.set` (idempotent command) for
   profile-scoped keys: `appearance` (`light`, `dark`, `system`), `reduced_motion`, and room
   for typography and keybindings (F014, F015). Unknown keys are refused. Changes reach the feed.
8. **CLI** for each: `ade workspace create-worktree`, `ade workspace delete-worktree`,
   `ade conversation mark-seen`, `ade review send`, `ade settings get|set`.

## Migrations

Write the schema change as a named function in this lane's own module and call it from a
provisional `if version < 18` block in `store/migrations.rs`. The coordinator assigns the final
number when merging.

## Acceptance

- `e2e/protocol/workspaces/` extended: project kinds and IDs for a main checkout, a linked
  worktree and a folder; `branch` follows a `git switch` done outside ADE; `create_worktree` and
  `delete_worktree` including replay, a dirty tree refused with blockers, the main checkout
  refused, and a crash injected between removing the workspace and removing the tree recovers.
- Attention and unread follow a real turn; review feedback reaches the conversation's queue.
- Old lifecycle IDs still resolve.
- Evidence in `.scratch/ade-v1/evidence/lane-b-catalog.md`.

## Comments
- 2026-09-29 — Done: projects, workspace kind/branch/default/ade_owned, `workspace.create_worktree`/`delete_worktree`, attention/unread/mark_seen, `review.feedback.send`, settings (`ab162f0`–`2d42071`); review fixes: busy repository waits, per-operation failure, re-checked blockers, kept news sequence, overlong prompt refusal (`26cfa90`–`f3291f0`). Evidence: `.scratch/ade-v1/evidence/lane-b-catalog.md`.
