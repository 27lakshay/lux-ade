# phase2-worktree-lifecycle

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-2
Worker: Phase 2 round C, worktree-lifecycle worker
Requirements: F063, F066, F067, F069 (advanced, not accepted); 05-S11 and 05-S12 (cleanup keeps the HostResources rules)

## Outcome

The lifecycle daemon now creates named trees from repository defaults, runs
setup and teardown hooks as supervised processes with bounded output, and
archives and cleans up trees under exclusive HostResources removal claims. Each
tree ADE creates carries a durable phase (`creating`, `setting_up`, `ready`,
`setup_failed`, …). Only `ready` admits an Agent, so a failed or interrupted
hook leaves the tree visibly failed and kept, never half-ready. No requirement
is accepted: acceptance needs the E2E evidence in the 05-workspaces spec.

## Operation tiers

| Operation | Tier | Reply | Change |
|---|---|---|---|
| `worktree.create` | effect command (receipt) | `worktree_state` | new: naming defaults, then `git worktree add -b`, then setup hooks |
| `worktree.setup` | effect command (receipt) | `worktree_state` | new: rerun setup hooks in an owned tree that is not ready |
| `worktree.cleanup.plan` | query | `worktree_cleanup_plan` | new: every linked tree with its blockers |
| `worktree.cleanup` | effect command (receipt) | `worktree_state` | new: 1–32 paths; per tree, reclassify, claim, teardown, remove, archive |
| `worktree.archived` | query | `worktree_archive` | new: newest 200 archive records |
| `worktree.configure` | idempotent command | `worktree_state` | config gains `branch_prefix`, `default_base`, `setup`, `teardown` |
| `worktree.switch` | effect command | `worktree_state` | a tree it creates now records phases and runs setup hooks |
| `worktree.remove` | effect command | `worktree_state` | runs teardown hooks first; writes an archive record |

Wire compatibility: new config fields and the new `phase` item field are
omitted while they hold their defaults, so existing replies are byte-identical.
With no hooks configured, `switch` and `remove` behave as before.

## Design

- **Naming (F066).** `name` gives `<branch_prefix><slug(name)>`; `branch` is
  used verbatim; neither generates the first free `<prefix>wt-N`. The directory
  is `<repo-dir>-<branch with / as ->` in the configured parent. An explicit
  name or branch that collides with an existing branch (case-folded, for
  case-insensitive volumes) or directory is refused; only generated names
  advance. The resolved branch, base and path are written to the ledger row
  (`result.resolved`, `worktree_path`) before Git runs.
- **Hooks (F067).** A hook is an argument vector, run without a shell, through
  the existing `--worktree-worker` supervisor, so the repository lock survives
  daemon death and a replaced tree directory fails closed (cwd identity check).
  The hook runs in its own process group with `ADE_HOOK_PHASE`,
  `ADE_WORKTREE_PATH`, `ADE_WORKTREE_BRANCH`, `ADE_REPOSITORY_ROOT` and
  `ADE_OPERATION_ID`. Each stream keeps its last 64 KiB. Hooks stop at the
  first that does not succeed. Verdicts: `succeeded`, `failed`, `timed_out`
  (process group killed), `unknown` (pipes held open after exit). Hook failures
  get codes `setup_hook_failed`, `teardown_hook_failed` or
  `hook_outcome_unknown`; messages name the hook, never its output.
- **Phases.** A new `trees` table in `lifecycle.sqlite3` keys each tree's phase
  by canonical path. `creating` is written before `git worktree add`;
  `setting_up` before the first setup hook; `tearing_down` before teardown. On
  open, an in-progress phase becomes `setup_interrupted` or
  `teardown_interrupted`. `setup_state` (Agent admission) reads the phase of
  the tree or of any ancestor of the leased path before the older job-based
  rule.
- **Claims.** Creation keeps its exclusive `create` claim through setup hooks;
  `worktree.setup` takes a shared `use` claim; teardown dispatches the
  exclusive `remove` claim before the first hook. A timed-out or unknown hook
  quarantines the claim (`hook_outcome_unknown`); a hook that finished releases
  it.
- **Cleanup (F069).** Blockers, from architecture section 5: primary checkout,
  not listed, external (no authority), authority changed, locked, prunable,
  dirty, status unknown, this profile's active lease, another lifecycle
  operation, any claim inside the tree, a quarantined claim, a blocked
  registry, incomplete setup, incomplete teardown. Cleanup reclassifies each
  tree against a fresh listing, skips blocked trees, and reports each tree as
  `archived`, `skipped`, `failed` or `unknown`. The ledger status is
  `succeeded` only when every tree was archived, `partial` when some were.
  Cleanup paths enter the in-memory removal set at admission, so no new lease
  starts inside them. Branch deletion (`merged` policy) uses `git branch -d`
  and is reported per tree.
- **Archive.** An `archived` table keeps path, branch, head commit, whether
  the branch was deleted, the operation ID and the time, for every tree ADE
  removes through `remove` or `cleanup`.

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build,
  typecheck, Fallow, JS build, JS pure tests, clippy, legacy Rust tests 346).
- In-process tests added:
  - `crates/ade-daemon/src/worktrees/policy.rs` (`#[cfg(test)]`): slugs,
    naming and collisions, configuration limits, hook verdicts, phase after
    setup and teardown, restart, readiness, `may_setup`, every cleanup blocker,
    cleanup status, output tail.
  - `crates/ade-core/src/contract/worktrees.rs`: request round trips for the
    new operations and hook config, reply round trips for plan, archive and
    the `phase` field.
- Scratch smoke run (not committed): a debug daemon in a scratch data
  directory, driven through the built CLI. Observed: named and generated
  creation with a setup hook, receipt replay and conflict, explicit-name
  collision refused (case-folded), failing setup hook leaves the tree owned,
  kept and `setup_failed` with the hook output in `worktree.operation`,
  `worktree.setup` retry, cleanup plan blockers (`dirty`,
  `setup_incomplete`), cleanup archiving one of three trees as `partial` with
  merged-branch deletion, archive record, a timed-out teardown hook in
  `worktree.remove` keeping the tree `teardown_failed` with its removal claim
  quarantined, and phases surviving a daemon restart.
  The smoke daemon attached to an existing development `ade-runtime` process
  (another worker's build) through the default runtime socket; lifecycle
  operations do not use the runtime, but a future smoke should set
  `ADE_RUNTIME_SOCKET`.

## Verified only statically

- Interrupted phases after a daemon crash mid-hook, and the quarantine that
  follows, were reasoned through, not exercised.
- `unknown` hook verdicts (a descendant holding the pipes) were not exercised.
- Cross-profile races between cleanup and another profile's use claim.

## Needs E2E or UI later

- F063: create through the desktop; recover a failed setup from the UI.
- F066: collision and generated-name cases through the public protocol.
- F067: streamed hook status. Hooks report only on completion today; the spec
  asks for streamed status.
- F069: cleanup UI from `worktree.cleanup.plan`; 05-S11 race of launch against
  cleanup through two profiles; 05-S12 escaped hook descendant.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 110 | 15 | 20 | 0 |

## References

- orca@b7a4fee7 `src/shared/workspace-cleanup.ts` — pattern: an explicit
  blocker list per candidate, with unknown Git status and uncertain terminal
  liveness as blockers.
- paseo@c356394 `packages/server/src/server/workspace-archive-service.test.ts`
  — pattern: a failed teardown keeps the directory; never remove a non-owned
  directory.
- t3code@e4eb9977 `apps/server/src/project/WorktreeSetupTracker.test.ts` —
  studied: setup stages do not step back. ADE makes phases durable instead of
  in-memory.
- No code was copied.

## Open

- Shared files the coordinator may want to change:
  - `crates/ade-daemon/src/bin/control/backup.rs`: restore clears `owned`; it
    should also clear the new `trees` table (a rebind clears it already, so
    this is tidiness, not safety). The `archived` table can stay.
  - `.scratch/ade-v1/requirements.md`: F063, F066, F067 and F069 remain
    `Unverified` until E2E evidence exists.
- Remaining work: streamed hook progress frames; hook environment policy
  (hooks inherit the daemon environment minus Git variables); restore of an
  archived tree from its branch; carry-changes (F064) and ignored-resource
  rules (F068) are separate slices.
- `worktree.switch` still has no naming defaults; callers that want them use
  `worktree.create`. The CLI keeps `worktree create` (switch form) and adds
  `worktree new` (create form).
