# Audit minor fixes: workspaces

Status: returned
Type: audit fix evidence
Branch: claude/wf_4acc9d19-6eb-2
Worker: audit-minor workspaces
Requirements: none (defects from the post-merge integration audit)

## Outcome

Six reported defects were traced against the code. Five were confirmed and fixed. For the sixth, the service.start part was already fixed on the branch, and the claim_worktree part was confirmed and fixed.

## Defects

| # | Defect | Confirmed | Fix | Test |
|---|---|---|---|---|
| 1 | A shared-use lease was admitted on a new tree while its unborn Create claim was still unbound | Yes. `Key::within` matched an unborn key only against the same reservation | `host_resources::born_inside_unborn` decides whether an existing path, or an ancestor of it, sits in the reserved parent under the reserved folded name. `take` refuses a checkout claim when an Exclusive unborn claim contains the path in this way. `resolve` now also returns the name of each node in the chain | `host_resources::tests::a_path_created_at_an_unbound_reservation_is_inside_it` |
| 2 | `worktree.remove` admission skipped the physical-identity check | Yes. It compared only `repository_id` and the marker token | `policy::authority_of` holds the pure decision, and `authority()` gathers its inputs. `policy::may_remove` gates Remove admission. `execute_git` rechecks `authority()` before removing | `worktrees::policy::tests::removal_needs_the_recorded_identity_not_just_the_marker` |
| 3 | Claims leaked when the repository lock file could not be opened in `start()` | Yes. The `?` returned before `release_claim` | An open error now goes through `release_claim` before it is returned | None. This is error-path plumbing with no decision to extract |
| 4 | Only `worktree.remove` refreshed terminal leases | Yes | `policy::needs_live_leases` covers four effects: `worktree.remove`, `worktree.cleanup`, `worktree.carry` and `worktree.adopt`. It also covers two queries: `worktree.cleanup.plan` and `worktree.carry.preview`. A failed refresh refuses an effect. For a query, a failed refresh is logged and the older, more conservative leases are used. `server.rs` dispatches on the result | `worktrees::policy::tests::every_operation_that_reads_active_work_refreshes_leases_first` |
| 5 | Publish reported a push with an unknown outcome as settled "not pushed" | Yes | `repository::decide::push_settlement` returns `Unknown` when Git was killed or timed out (`exit_code` None) and the remote does not confirm the commit. This covers a read-back that fails or reports `false`. The receipt settles as `Status::Unknown`, and the `unknown()` error is returned | `repository::decide::tests::a_killed_push_that_the_remote_does_not_confirm_is_unknown` |
| 6 | `service.start` held the Sessions lock across subprocesses, and `claim_worktree` ran Git under the worktrees mutex | Partly. `start_service` already runs its lease, reservation and launch outside the lock (phases 2 and 4). `claim_worktree` did run `git rev-parse` under the worktrees mutex in adopt and in create | `admin_dir()` runs `git rev-parse --absolute-git-dir` before the mutex is taken. `claim_worktree` now takes the admin dir as an argument | None. This moves a call and has no decision to extract |

## Operation tiers

No operation was added. Tiers are unchanged. The wire contract is unchanged.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/host_resources.rs`
  - `crates/ade-daemon/src/worktrees/policy.rs`
  - `crates/ade-daemon/src/repository/decide.rs`

## References

None.

## Open

- `worktrees::start` and `adopt` still hold the worktrees data mutex while `HostResources::acquire` runs an IMMEDIATE registry transaction. The documented lock order is data, then registry. `Lease::drop` takes that mutex while the Sessions lock may be held, so a registry that another profile keeps busy can still delay Sessions for up to the 5 s busy timeout. The audit did not report this, and it was left alone.
- A push that Git reported as successful (exit 0) but that the remote read-back cannot confirm still settles as `NotPushed` with `failed_step: Verify`. The strict reading of the reliability bar would make this unknown as well.
- A push that fails to spawn also reports `exit_code` None, so it now settles as unknown rather than not pushed. This is conservative.
