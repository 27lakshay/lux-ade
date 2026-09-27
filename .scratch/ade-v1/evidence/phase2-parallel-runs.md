# parallel-runs

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-10
Worker: Phase 2 parallel build, round C, slice parallel-runs
Requirements: F105 (parallel runs and comparison); backend and CLI foundations only, not accepted

## Outcome

A Conversation can now start one task as 2 to 8 sibling children under one
parallel group, one run per provider or account. Each run states its provider,
account and workspace explicitly. One `state.sqlite` transaction commits the
receipt, the group, every child Conversation, every child link and every queued
task, so a group is never half created and a retry never creates it twice. The
group records each run's workspace HEAD at the start. The group's runs can be
listed with their status, and the group can be compared: each run's outcome,
its uncommitted changes as `review.status` reports them, what it committed since
the start, whether its workspace is shared, and the paths that more than one
workspace changed. The comparison reads Git and changes nothing. The CLI gains a
`runs` area. By default it creates one new worktree per run in the parent's
repository.

Rules in `crates/ade-daemon/src/sessions/orchestration/group_policy.rs`:

- A group needs 2 to 8 runs. Two `new_worktree` runs may not name the same
  workspace. Sharing the parent's workspace is allowed only when a run states
  `same`.
- Every run passes the existing delegation rules: caller attribution, the
  explicit account (`inherit` needs the parent's provider), the verified
  `new_worktree` evidence, depth 4 and 32 children per parent in total.
- The group state needs evidence. It is `needs_attention` when any run asks a
  question or is blocked, `running` when any run is pending, `completed` only
  when every run completed, and `ended` otherwise. An unknown or unavailable
  run never counts as completed.
- A run whose workspace is the parent's or another run's is marked
  `shared_workspace`, because its changes are not its own alone. Overlaps count
  workspaces, not runs.
- A run's committed changes are `unknown`, never an empty list, when the group
  had no base commit, the branch is unborn or Git cannot compare. Malformed Git
  output is an error, never a shorter list.

## Operation tiers

| Operation | Tier |
|---|---|
| `orchestration.group.start` | effect command (receipt in `state.sqlite`) |
| `orchestration.groups` | query |
| `orchestration.group.get` | query |
| `orchestration.group.compare` | query; reads Git only |

New tables, created idempotently on first use in `state.sqlite`:
`orchestration_groups` and `orchestration_group_runs`. No migration and no
backup version pin changed. Existing orchestration operations keep their wire
shape; `delegate` and `child.wait` now share helpers with the group code.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/sessions/orchestration/group_policy.rs` (6 tests:
    run admission, group summary, attention order, workspace sharing, overlaps,
    `--name-status -z` parsing)
  - `crates/ade-core/src/contract/orchestration.rs` (2 schema round-trip tests
    for the group operations)

A manual smoke run against scratch daemons, with `ADE_CODEX_BIN=/usr/bin/false`
so no real provider ran, showed:

- a group start, its replay with the same ID, and a conflict on a changed task;
- refusal of a forged Agent caller and of `inherit` across providers, with no
  partial group left behind;
- both runs reported `settled`/`failed` and the group `ended`;
- comparison outside Git reported each run `unavailable`;
- comparison in a Git worktree with `same` runs reported the base commit,
  `known` committed changes (0 commits), the uncommitted files, and both runs as
  shared, with no overlaps.

This is not committed test coverage.

Verified only statically:

- the CLI default path (a new worktree per run, derived from the operation ID,
  then `orchestration.group.start` with `new_worktree` runs);
- overlaps between runs in different worktrees;
- committed changes with real commits after the start;
- `needs_attention` with a real provider question.

Needs E2E or UI later:

- F105: start a group on two providers in new worktrees, let both edit the same
  file, and see each run's outcome, changes and the overlap, with nothing merged.
- F105 with shared workspaces: runs marked shared, and no per-run attribution
  claimed.
- 09-S08 for `orchestration.group.start`: same ID and payload deduplicate; a
  changed payload conflicts.
- A comparison view in the UI.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 10 | 20 | 0 |

## References

- The orchestration slice's delegation code (`sessions/orchestration.rs`,
  `policy.rs`) is the base; group start reuses its admission, account and
  worktree rules, now through the shared `insert_child` and `observe` helpers.
- OpenCode-v2 @ 2c369a2, `packages/core/src/session/subagent-job.ts`, studied
  (reference map row "API and orchestration"): each child session is an
  independent job, observed per job generation. ADE keeps each run an
  independent child Conversation and adds a durable group record in SQLite.
- No code was copied, so no `THIRD-PARTY-NOTICES.md` entry is needed.

## Open

- Shared file edits the coordinator should know about: `apps/cli/src/index.ts`
  gains one import, one usage entry and one command-area entry for `runs`. The
  `sessions.rs` dispatch already routes `orchestration.*`, so it is unchanged.
  `apps/cli/src/commands/orchestration.ts` now exports `command`, `caller`,
  `operationId` and `newWorktree` for `runs.ts`.
- A run's child link carries `operation_id` `<group ID>/<index>`, which is not a
  receipt ID; the group's receipt is under the group's `operation_id`.
- The CLI puts every run in the same workspace mode. Mixing `same` and
  `new_worktree` runs in one group needs `ade request orchestration.group.start`.
- A worktree made by the CLI for a run of a group that then fails admission is
  left in place. A retry with the same `--operation-id` reuses it.
- The base commit is read before the store transaction. A commit made in that
  gap would count as the base, not as the run's work.
- No push feed for group status; clients poll `orchestration.group.get`.
- No group-level cancel. Cancel each run with `agent.cancel` on its child.
- Remote hosts and the spec's `context` binding are not modelled, as for F104.
- Conflict and expiry errors stay plain messages (`code: daemon`), as for
  `orchestration.delegate`.
