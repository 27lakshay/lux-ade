# checkpoints

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-3
Worker: Phase 2 round C, checkpoints worker
Requirements: F070 (advanced, not accepted); workspaces spec rule 7 (coverage disclosure, restore preview, changed-precondition detection, partial-failure reporting)

## Outcome

The profile daemon can now checkpoint a workspace's working tree and index as
Git objects under `refs/ade/checkpoints/<workspace>/<checkpoint>`. It can list
checkpoints, preview a restore, restore one, and delete one. It never writes the
user's branch, index or stash when it creates a checkpoint. Restore is previewed
first, refuses when anything changed since the preview, and refuses to overwrite
ignored files. It needs explicit confirmation before it replaces uncommitted
work, and it saves a safety checkpoint before writing anything. An `ade
checkpoint` CLI area drives all five operations. F070 is not accepted: there is
no UI and no E2E coverage.

## Operation tiers

| Operation | Tier | Notes |
|---|---|---|
| `checkpoint.create` | effect command | Receipt in the profile database. The dispatched receipt names the ref; replay after a crash reconciles from whether that ref exists. |
| `checkpoint.list` | query | Reads refs; unreadable refs are reported as `problems`, not dropped. |
| `checkpoint.restore.preview` | query | Returns `changes`, `uncommitted_overwritten`, `ignored_overwritten`, `head_changed`, a verdict and a `state_token`. Writes Git tree objects but no ref and no index. |
| `checkpoint.restore` | effect command | Requires `expected_state`. Receipt phases: dispatched (nothing written), writing (safety checkpoint saved, files may change), settled. A replay of an open writing-phase receipt becomes unknown and never runs again. |
| `checkpoint.delete` | effect command | Requires `expected_commit`; `update-ref` deletes only if the ref still points there. |

Design notes:

- A checkpoint commit's tree is the working-tree snapshot (tracked plus
  untracked, non-ignored files). Its last parent is an index commit whose tree
  is the index; its first parent is HEAD when HEAD exists. Metadata (kind,
  label, head, branch, coverage) is a JSON trailer in the commit message. Git
  is the only store of checkpoint state; no SQLite table was added. Receipts use
  the existing `operations` table in the profile database.
- Snapshots use a temporary index in the Git directory, copied from the real
  index with its timestamp one second older (racy-Git rule).
- The restore-safety decision is the pure `decide` function in
  `crates/ade-daemon/src/checkpoints/decide.rs`. Refusals leave no receipt.
- The working tree is written with `git read-tree -m -u` on the snapshot's own
  temporary index, so Git refuses if a file changed after the snapshot. The
  index is written only if the real index still matches the snapshot. A fresh
  snapshot afterwards sets `verified`; a mismatch reports `outcome: partial`.
- Refused layouts: a workspace that is not the top of a Git working tree,
  sparse checkouts, assume-unchanged or skip-worktree entries, unresolved
  conflicts, and (for restore) a merge, rebase, cherry-pick or revert in
  progress or a held index lock.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/checkpoints/decide.rs`: restore decision (unchanged, proceed, confirmation, stale preview, ignored overwrite, blockers), uncommitted intersection, state token, ref names, labels, message codec, commit parsing, name-status parsing, mode counts, hidden index entries
  - `crates/ade-core/src/contract/checkpoints.rs`: declared tiers, request and reply round trips, unknown and missing field rejection
- Manual smoke run, not a gate: a debug daemon with a fixture repository under
  `target/`, driven through the built CLI. It covered create with a modified,
  a staged, an untracked, an ignored and a binary file (user status, branch and
  stash unchanged afterwards); preview (`needs_confirmation`); restore refused
  without confirmation and with a stale token; restore with confirmation
  (`verified: true`, status matched the checkpoint exactly, the removed file
  kept in the safety checkpoint); replay of the same ID returned the stored
  reply; the same ID with other parameters conflicted; restore blocked by an
  ignored file in the way (file left intact); delete refused with a wrong
  commit, then deleted, then replayed; create and restore on an unborn branch
  with a symbolic link; and a workspace below its repository root refused.

Verified only statically: crash reconciliation of open receipts, the
one-effect-per-workspace claim, the partial-restore and index-changed-mid-restore
paths, and the drain guard.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 5 | 15 | 0 |

## References

- t3code @ ade-evaluation-2026-09-24 `apps/server/src/vcs/GitVcsDriver.ts` (checkpoints section) — copied pattern → `crates/ade-daemon/src/checkpoints.rs` (temporary index in the Git directory, racy timestamp on the copy, `core.fsync` options, `commit-tree` plus `update-ref` under a hidden ref). MIT; the file carries a "Portions adapted from" header.
- t3code @ ade-evaluation-2026-09-24 `apps/server/src/checkpointing/CheckpointStore.ts` — studied (service boundary). Its restore uses `git restore` plus `git clean -fd` with no overwrite check; ADE does not follow that.

## Open

- `THIRD-PARTY-NOTICES.md` needs a t3code (MIT) entry for `crates/ade-daemon/src/checkpoints.rs`. Coordinator file.
- E2E: create, preview and restore through the running app; crash between
  receipt phases; concurrent edits during restore.
- UI: checkpoint list, restore preview with confirmation, safety checkpoint display.
- Other ADE writers (agents, `file.*`, review discard) do not take the
  checkpoint workspace claim. Git's `read-tree` up-to-date check narrows the
  race to the index step, but it is not closed.
- Checkpoint refs live in the shared Git common directory, so `git push --mirror`
  would publish them. No retention or pruning policy exists yet.
- Git output is capped at 4 MiB per command (the shared runner), so very large
  repositories fail closed on `ls-files -v` or `ls-tree`.
- Ignored-path detection treats an existing directory at an added path as
  occupied, which may block a restore that Git could perform.
- Diff and file previews of a checkpoint, per-path restore, and a
  conversation-linked checkpoint timeline remain.
