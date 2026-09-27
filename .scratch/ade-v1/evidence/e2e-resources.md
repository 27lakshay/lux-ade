# e2e-resources

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-9
Worker: E2E round 1, resources worker
Requirements: 05-S11, 05-S12, F070 (full E2E acceptance passes); F062, R007 (advanced, not accepted)

## Outcome

Headless E2E specs in `e2e/protocol/resources/` now prove HostResources
across real profiles, file checkpoints, and repository clone and publish
against real daemons and runtimes. 14 specs pass and 1 is `test.fixme`. The
specs exposed three product bugs in this area, and all three are fixed:

- A stopped terminal kept its host-wide shared-use claim until the owning
  profile's next lifecycle command. Until then, no other profile could remove
  the checkout.
- A worktree created at a non-canonical path (for example, under `/var`, which
  is a symbolic link to `/private/var` on macOS) succeeded, but its creation
  claim was left quarantined as `outcome_unknown`.
- When a second profile tried to create a worktree at a path that another
  profile was creating, the refusal was the untyped "Worktree path already
  exists". The daemon now reports the other profile's claim as
  `host_resource_conflict`.

## Acceptance criteria and specs

HostResources (`e2e/protocol/resources/host-resources.spec.ts`):

| Criterion | Spec | Result |
|---|---|---|
| 05-S11: two profiles compete for one checkout; the removal gets an explicit conflict; the checkout and its shell survive | a profile cannot remove a checkout another profile works in, by its path or an alias | pass |
| 05-S11: a launch races a removal through different profiles; only one valid claim wins; an active checkout is never deleted (3 rounds) | a launch racing a removal in another profile leaves one winner and never deletes an active checkout | pass |
| Arch. 5: an unborn-path reservation conflicts across profiles (the explicit `host_resource_conflict` while the first creation is held in Git) | two profiles reserving the same unborn path: one creates it and the other gets an explicit conflict | pass |
| R007 (part): a symbolic-link alias is the same resource | first spec, alias check | pass |
| 05-S12: an escaped descendant outlives its terminal, runtime and daemon; the claim is quarantined (`owner_lost_during_use`) and keeps conflicting until explicit resolution; wrong `confirm_path` refused; duplicate resolve replays; a reused ID with other parameters conflicts | an escaped descendant keeps the checkout quarantined after its profile dies, until explicit resolution | pass |
| Arch. 5: a daemon crash quarantines a live claim; lock loss never clears it; the restarted daemon re-leases the same key and supersedes its own quarantined claim | a daemon crash quarantines a live checkout claim, and the restarted daemon takes it back | pass |
| R007 (part): a missing registry with a live owner is never recreated empty; lifecycle is refused with `host_resources_unavailable`; an unreadable registry is moved aside only after explicit `resources.registry.accept` | a lost or unreadable registry blocks lifecycle commands until the profile accepts it explicitly | pass |
| R007: replacement at the same path; registry migration; corruption while owners stay live; port and device claims | none | not covered |

Checkpoints (`e2e/protocol/resources/checkpoints.spec.ts`):

| Criterion | Spec | Result |
|---|---|---|
| F070: create a checkpoint with modified, staged, untracked, ignored and binary files; coverage disclosed, including `not_covered` (ignored files, running processes); the user's branch, index, stash and refs are untouched; list; duplicate and reused-ID requests; the checkpoint survives a daemon crash | a checkpoint records the tree and index, discloses its coverage and leaves the user's Git state alone | pass |
| F070: preview; refusal to overwrite unsaved changes without confirmation; refusal of a stale preview after a concurrent edit; a confirmed restore matches the checkpoint exactly (tree, index, binary bytes); a safety checkpoint is saved and brings the replaced work back; a duplicate restore replays without writing | restore refuses to overwrite unsaved changes without confirmation or after they changed, then restores exactly | pass |
| Rule 7: an ignored file in the way blocks the restore and is left intact | restore refuses to overwrite an ignored file in its way and leaves it intact | pass |
| Delete needs the expected commit; duplicate replays | delete needs the commit the caller saw and replays a duplicate request | pass |
| A crash between restore receipt phases | none | not covered (no fault hook between phases) |

Repository (`e2e/protocol/resources/repository.spec.ts`):

| Criterion | Spec | Result |
|---|---|---|
| F062: coverage (`forge_apis: false`); clone from a local bare repository over `file://` registers a workspace; duplicate replays; a reused ID refused; an existing path refused and left intact; a bare local path and a missing remote refused with nothing left behind | clone from a local bare repository registers the project and never writes over an existing path | pass |
| F062: publish a plain folder into an empty bare repository; initial commit only when asked; duplicate replays; an existing remote is never repointed; a diverged remote is never force-pushed (`not_pushed`, `failed_step: push`) | publish initialises a folder, commits only when asked, adds the remote and pushes without force | pass |
| F062: a `git push` killed mid-flight (held in the remote's pre-receive hook) settles as unknown, never "not pushed"; the replay never pushes again; the folder holds a shared-use claim while it pushes | a push whose Git process is killed settles as unknown and never pushes again | pass |
| F062: a daemon killed during the push; after restart, the replay reconciles the `pushing` receipt as unknown | a daemon killed during a push settles the publish as unknown after restart | pass |
| An unknown outcome carries the typed `outcome_unknown` code | an unknown publish outcome carries the typed outcome_unknown code | fixme (gap below) |
| F062: clone onto a selected remote host; publish through a real credential flow (HTTPS or SSH) | none | not covered |

## Product fixes

- `crates/ade-daemon/src/bin/daemon/server.rs`: `terminal.stop` and
  `terminal.retire` now refresh the worktree leases afterwards. A stop first
  waits up to 2 s for the runtime to report that the shell exited, because the
  runtime reaps the shell on its own thread. A checkout that is no longer in
  use then releases its host-wide claim at once. Proven by the first
  HostResources spec.
- `crates/ade-daemon/src/worktrees.rs` `creation_path`: returns the canonical
  path (the canonical configured directory joined with the final name). Git
  lists trees by canonical path, so the settlement now observes the created
  tree and releases the claim instead of quarantining it. Proven by the
  unborn-path spec.
- `crates/ade-daemon/src/worktrees.rs` (creation admission): when the target
  path already exists, the daemon first probes the host registry. If another
  profile's claim covers the path, that `host_resource_conflict` is returned,
  with recovery `inspect_host_resources`. Otherwise the probe is released and
  the old "Worktree path already exists" error is kept. Proven by the
  unborn-path spec.

No pure-core test was added. The three fixes are plumbing: path
normalisation, error ordering and a lease refresh. None involves a new
decision function.

## New generic fixtures

- `e2e/protocol/fixtures/host-profiles.ts`: `startHostProfiles(ade, n)` starts
  scratch profiles with the managed layout `<home>/profiles/<uuid>/runtime`
  that `ade-control` uses. Their daemons then share one host registry under
  the test root, exactly as managed profiles do.
- `e2e/protocol/fixtures/raw-reply.ts`: `rawReply(profile, request)` returns
  the whole reply frame, error frames included, so a spec can assert the
  daemon's `code` and `recovery`. `profile.rpc` drops both, and the SDK maps
  unknown codes to `daemon`. It logs to `operations.jsonl` like the other
  helpers.

## Operation tiers

No operation was added or changed. The wire contract is unchanged.

## Checks

- `pnpm check:static`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/resources`: 14
  passed and 1 skipped (fixme). It ran three times in a row with no failures.
  `boot` still passes (7 of 7).
- In-process tests added: none.
- No `ade-daemon` or `ade-runtime` from this worktree was left running
  (`pgrep`).

## Bugs outside this area (not fixed)

- The SDK (`packages/client/src/request.ts`) maps every daemon error code it
  does not know to `daemon` and drops `recovery`. This covers
  `host_resource_conflict`, `host_resources_unavailable`, `needs_rebind` and
  the `lifecycle_*` codes. The CLI inherits this: it prints `code: daemon` and
  exits 7. Failing spec: none, because the specs read raw frames through
  `rawReply`. Reproduce with `profile.call('worktree.remove', ...)` against a
  claimed checkout: `error.code` is `daemon`.
- After another profile removed a checkout that a profile had open as a
  workspace, that profile refuses `workspace.open` for an unrelated folder
  with "Workspace needs_rebind before execution can use its saved path". This
  is in the workspaces or rebind area. The race spec uses a fresh worker
  profile for each round to work around it; round 2 of the original single-worker
  version failed on it.
- `worktree.adopt` from a second profile of a tree that another profile
  created fails with the raw error "File exists (os error 17)". The creator's
  `ade-owner` marker in the tree's Git admin directory blocks it. The message
  is untyped, and it is unclear whether the creator is meant to be a
  permanent restriction (spec rule 4 says it is not). This is in the worktree
  adoption area. The specs adopt only external trees.
- The `worktree.adopt` reply carries the cached listing, which does not yet
  show the adopted tree. A `worktree.refresh` is needed to read `ade_owned`
  back.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 20 | 0 |

## References

- `e2e/protocol/README.md` and `e2e/protocol/fixtures/*` (in-repo), pattern.
- `.scratch/ade-v1/evidence/phase2-host-resources.md`,
  `phase2-checkpoints.md`, `phase2-repo-clone-publish.md` and
  `audit-minor-workspaces.md` (in-repo): the "needs E2E later" lists these
  specs cover.

## Open

- **Coordinator, shared file:** `crates/ade-core/src/error.rs`
  `error_envelope` has no typed variant that keeps an operation's own message
  and emits `code: outcome_unknown`. Repository clone and publish, and
  probably checkpoint replay, report unknown outcomes untyped. The fixme spec
  names the gap.
- R007 still needs: replacement at the same path, registry migration,
  corruption while owners stay live (WAL frames at the registry path would
  resurrect an overwritten file), and port and device claims.
- F062 still needs clone onto a selected remote host and a real credential
  flow.
- There is no fault injection between checkpoint restore receipt phases.
