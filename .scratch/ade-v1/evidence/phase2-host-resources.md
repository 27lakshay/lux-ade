# host-resources

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-2
Worker: Phase 2 round B, slice host-resources
Requirements: R007, 05-S11, 05-S12, F063, F069 (advanced, not accepted)

## Outcome

A new module, `crates/ade-daemon/src/host_resources.rs`, keeps a host-local
claim registry, `host-resources.sqlite3`, in the profiles home next to
`registry.json`. Every managed profile's daemon opens the same file. Worktree
creation and removal take exclusive lifecycle claims, and every worktree lease
takes a shared-use claim. When a profile tries to remove or create a checkout
that another profile holds, the daemon refuses with
`code: host_resource_conflict`. No requirement is fully accepted: acceptance
needs E2E runs with real profiles.

- **Key:** host ID plus the (device, inode, birth-time generation) chain from
  the resource up to `/`. Symlink aliases collide. A replacement at the same
  path gets a new key. An unborn path is keyed by its parent's chain plus its
  lower-cased final name. After Git creates the directory, the claim is bound
  to the created identity.
- **Compatibility** (`conflicts`):
  - Two shared claims never conflict.
  - An exclusive claim refuses shared use on or inside it.
  - An exclusive claim refuses another exclusive claim on, inside or around it.
  - Using an ancestor directory does not block a child's lifecycle.
- **Phases:** use claims start `active`. Lifecycle claims start `reserved`,
  and `dispatched` is committed before Git runs; a failed commit stops the
  effect. A creation is `bound` after its path is bound to the created
  identity.
  - The claim is released once the actual state was read back after Git
    exited (`settle_lifecycle`).
  - If Git timed out, or the listing failed, the claim is quarantined as
    `outcome_unknown`.
- **Owner loss:** each daemon incarnation holds a flock under
  `host-resources.owners/`. A lost lock or a missing PID never clears a claim
  (`on_owner_lost`):
  - A reservation that never dispatched is released.
  - A dispatched or bound claim is quarantined as `outcome_unknown`.
  - A use claim is quarantined as `owner_lost_during_use`.
  - A quarantined claim keeps conflicting. It ends in one of two ways. Its
    own profile can re-claim the same key after restart and reconciliation
    (`superseded_by`). Otherwise, `resources.claim.resolve` releases it
    explicitly.
- **Corruption and replacement:** the profile's lifecycle DB records which
  registry host ID it bound to, in a new idempotent table,
  `host_resources_binding`.
  - A bound profile never creates a missing registry.
  - A registry that is replaced, unreadable, fails `quick_check` or has an
    unsupported format blocks new claims. Lifecycle commands are refused with
    `code: host_resources_unavailable`.
  - Leases are still admitted, unrecorded, so the daemon can start and stop
    existing work.
  - `resources.registry.accept` recovers explicitly. It moves an unreadable
    file aside and never deletes it.
- **Location:** `ADE_HOST_RESOURCES_HOME` overrides. Otherwise the registry
  goes in `<H>` when `ADE_RUNTIME_HOME` is `<H>/profiles/<uuid>/runtime`, the
  layout that `ade-control` creates. A daemon outside that layout keeps a
  private registry in its lifecycle directory and reports `scope: "profile"`.

## Operation tiers

- `resources.inspect`: query. It returns the registry status and its claims,
  optionally filtered to claims on, inside or around one path.
- `resources.claim.resolve`: effect command. It releases one quarantined claim
  after `confirm_path`. Its receipt lives in the registry DB.
- `resources.registry.accept`: effect command. It rebinds the profile to the
  registry on disk after `confirm_registry`. Its receipt lives in the profile's
  lifecycle DB.
- `worktree.switch` and `worktree.remove`: unchanged wire. They can now fail
  with `host_resource_conflict` or `host_resources_unavailable`.

## Checks

- `pnpm check:static`: pass.
- In-process tests added:
  - `crates/ade-daemon/src/host_resources.rs` (`#[cfg(test)] mod tests`, 11
    pure-core tests): compatibility, nesting, identity versus path, unborn
    names, owner loss, lifecycle settlement, supersession, resolution, the
    registry opening decision, verification and location.
  - `crates/ade-core/src/contract/resources.rs`: a schema round-trip test.
- A throwaway in-process smoke test ran and was removed before commit, per
  policy. It used two registries sharing one directory to emulate two profiles
  and confirmed four things:
  - A removal is refused when another profile holds a shared claim on a
    subdirectory or through a symlink alias.
  - Dropping the owner quarantines its claim, which keeps refusing.
  - Explicit resolution admits the removal.
  - A corrupt file blocks new claims, and accepting it moves the file aside.
    A missing registry is never recreated for a bound profile.

**Verified only statically:** the worktree lifecycle integration (reserve,
dispatch, bind, settle in `worktrees.rs`), lease claims across real daemons,
daemon-restart quarantine and supersession, and `ade-control` path layout
detection with real profiles.

**Needs E2E later:**

- 05-S11: race launch and removal across two real profiles.
- 05-S12: escape a descendant and lose its parent, then see the claim
  quarantined.
- R007: path aliases and replacement, and a corrupt registry with live owners.
- F063/F069: failure paths through the CLI.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 80 | 10 | 5 | 0 |

## References

- orca `src/main/runtime/worktree-terminal-mutation-lock.ts` and `.test.ts`:
  studied for the shared and exclusive vocabulary. ADE refuses at once with an
  explicit conflict instead of queueing, and it persists claims across
  processes. No code was copied.
- `crates/ade-daemon/src/sessions/leases.rs` (in-repo): its verdict rule, that
  only proof releases, is mirrored by `on_owner_lost`.
- `crates/ade-daemon/src/bin/control/main.rs` (in-repo): the profiles home
  layout and `ADE_PROFILES_HOME`.

## Open

- **Coordinator, shared files:**
  - `crates/ade-core/src/error.rs` gained two additive error types and their
    envelope branches: `host_resource_conflict` and
    `host_resources_unavailable`.
  - `crates/ade-daemon/src/lib.rs` gained one `pub mod` line.
  - `sessions.rs` gained one match arm that routes `resources.*`.
- No CLI command was added. `index.ts` would need more than one line. For now,
  `ade request resources.inspect '{}'` works.
- **Not done:**
  - Ports, devices and host admission budgets. Only checkouts are covered.
  - The runtime does not own claims yet. The daemon holds them, and after a
    daemon restart, prior-incarnation use claims stay quarantined until the
    profile re-claims the same key or the user resolves them.
  - External-worktree adoption does not check claims.
  - Unicode normalization is not folded; only case is folded.
  - A brand-new, unbound profile could still create a replacement registry
    after the file was deleted, though bound profiles then block.
- **Created-worktree window:** the creation claim is keyed on the unborn name
  until it is bound. Between Git creating the directory and the bind, a
  shared claim taken inside the new directory is not seen as a conflict.
