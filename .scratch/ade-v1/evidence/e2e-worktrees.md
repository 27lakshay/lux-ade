# e2e-worktrees

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-1
Worker: E2E round 1, worktrees worker
Requirements: F063, F064, F065, F066, F067, F068, F069

## Outcome

Headless E2E specs in `e2e/protocol/worktrees/` now drive the worktree
lifecycle, carry, adoption and ignored-resource rules through the SDK and the
CLI against real daemons, runtimes and Git. They found two product bugs, both
fixed: carry's `clean_source` never cleaned anything, and a link rule under a
directory-only ignore pattern left the tree dirty and blocked its cleanup.
F063, F064, F065, F066, F068 and F069 now pass their full register
acceptance. F067 does not: hooks report only on completion, and streamed
status is marked `test.fixme`.

## Acceptance criteria

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| F063 | Create at an explicit or deterministic path through ADE's Git lifecycle | `lifecycle.spec.ts` › create applies the branch prefix… | pass |
| F063 | Reserve the physical resource before launch | `lifecycle.spec.ts` › a tree being created is reserved host-wide… (two profiles, shared registry) | pass |
| F063 | Failed setup is visible and recoverable without deleting the tree | `lifecycle.spec.ts` › setup hooks run in the tree…; › an interrupted setup survives a daemon crash… | pass |
| F064 | Preview and transfer selected dirty changes | `carry.spec.ts` › an exact carry moves only the selected changes… | pass |
| F064 | Preserve the source until success | `carry.spec.ts` › exact (cleaned only after verification); › merge-tree (kept, `base_differs`); › staged and unstaged (kept, both versions intact) | pass |
| F064 | Report conflicts without discarding unselected work | `carry.spec.ts` › a conflicting carry applies nothing… | pass |
| F064 | Refusals: dirty target, stale head, unowned target, primary target, nothing to carry | `carry.spec.ts` › a carry is refused for… | pass |
| F064 | Duplicate request, conflicting reuse, daemon crash after a carry | `carry.spec.ts` › exact (replay and conflict); › a settled carry survives a daemon crash… | pass |
| F065 | Open external trees without taking removal authority | `adopt.spec.ts` › an external tree is protected… | pass |
| F065 | Explicit, confirmed adoption after repository and physical-path checks | `adopt.spec.ts` › an external tree is protected…; › a tree replaced at the same path loses the authority… | pass |
| F065 | Adoption refused under another profile's removal claim | `adopt.spec.ts` › adoption is refused while another profile holds a removal claim… | pass |
| F065 | A supported PR source resolves into a checkout, no PR workflow | `adopt.spec.ts` › a pull-request head fetched from a configured remote… (CLI `--pr 7`) | pass |
| F066 | Naming and base defaults, generated names | `lifecycle.spec.ts` › create applies the branch prefix… | pass |
| F066 | Collisions detected (case-folded), never renumbered | same | pass |
| F066 | Resolved branch and directory recorded before hooks | same (`result.resolved`); › setup hooks run in the tree… (the hook sees the branch and path) | pass |
| F067 | Hooks run with the correct host and workspace context | `lifecycle.spec.ts` › setup hooks run in the tree with its context… | pass |
| F067 | Stream status | `lifecycle.spec.ts` › setup hooks stream their status while they run | fixme: no frame or query exposes a running hook |
| F067 | Failure exposed; safe recovery before destructive cleanup | `lifecycle.spec.ts` › setup hooks…; › a failed teardown keeps the tree… | pass |
| F068 | Explicit copy, link and skip rules | `resources.spec.ts` › rules copy, link and skip… | pass |
| F068 | Conflicts reported, never replaced | same (`worktree.resources.apply` twice) | pass |
| F068 | Unsafe sources stop creation before setup | `resources.spec.ts` › an unsafe source stops creation… | pass |
| F068 | Externally owned files survive cleanup | `resources.spec.ts` › rules copy, link and skip… (cleanup keeps the primary's `node_modules`) | pass |
| F069 | Inspect dirty, locked and active state | `lifecycle.spec.ts` › cleanup archives only eligible trees… | pass |
| F069 | Refuse conflicting removal; only own or adopted trees | same, and `adopt.spec.ts` › an external tree is protected… | pass |
| F069 | Quarantine uncertain execution ownership | `lifecycle.spec.ts` › a failed teardown… (timed-out hook: `claim_uncertain`); › an interrupted setup… (quarantined create claim, resolved with `resources.claim.resolve`) | pass |
| F069 | Branch deletion is a separate, reported outcome | `lifecycle.spec.ts` › cleanup archives only eligible trees… | pass |

Not covered: an edit racing carry's source cleanup, and a daemon killed
between the carry ref and the target write. Neither can be timed
deterministically without a test hook in the product.

## Product fixes

1. **Carry never cleaned its source.** `clean_source` listed the carried
   paths with `git ls-files --pathspec-from-file`, an option `ls-files` does
   not have. Git exited 129 and every requested cleanup ended
   `cleanup_incomplete`. `clean_source` now lists the whole index and
   filters it with the new pure `carry::known_paths`.
2. **Carry's cleanup read-back failed after deleting an addition.** The
   read-back snapshot passed every carried path to `git add`. An untracked
   file that the cleanup had just deleted matched nothing, so `git add`
   failed. The read-back now names only paths still on disk or in `base`
   (new pure `carry::readback_paths`).
3. **A link rule could leave the tree dirty.** Git treats a symbolic link as
   a file. So with `node_modules/` in `.gitignore`, a `node_modules` link
   showed as untracked, which blocked `worktree.cleanup` and
   `worktree.remove`. After it creates a link, ADE now runs
   `git check-ignore` in the tree. If the link is not ignored, ADE removes
   it and reports `not_ignored`, with an error saying to ignore the path
   without the trailing slash (new pure `resources::link_kept`). This
   conservative choice keeps cleanup working. The alternative is to remove
   ADE's own links before removal. That would keep links working under
   directory-only patterns, but it needs a decision.

## Operation tiers

No operation was added or changed. The wire contract is unchanged.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/worktrees`:
  19 passed, 1 fixme.
- `pnpm check:static`: pass (728 Rust tests, 5 skipped).
- In-process tests added: `crates/ade-daemon/src/worktrees/carry.rs`
  (`source_cleanup_resets_only_indexed_or_base_paths_once`,
  `the_cleanup_read_back_skips_additions_that_are_gone`),
  `crates/ade-daemon/src/worktrees/resources.rs`
  (`a_link_stays_only_when_git_ignores_it_in_the_tree`).
- No `ade-daemon` or `ade-runtime` from this worktree was left running.

## Findings that are not bugs

- `cleanup.plan` reports `claim_held` beside `active_work` for a tree with a
  terminal of this profile, because the lease holds a host claim.
- `worktree.get` serves the cached listing. A tree whose creation has not
  settled is absent until `worktree.refresh` or completion.
- A rule path beyond a symbolic link reports `not_ignored`, not `unsafe`.
  Git will not answer for such a path. Nothing is copied.
- Carry's source cleanup leaves an empty parent directory after it deletes
  a carried addition. Git does not track empty directories.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 5 | 15 | 0 |

## References

None.

## Open

- F067 streamed hook status (fixme in `lifecycle.spec.ts`).
- The link-rule decision in fix 3: keep refusing unignored links, or have
  teardown remove ADE-created links before `git worktree remove`.
- Carry's source cleanup swallows the Git error behind `cleanup_incomplete`.
  Recording it in `result.carry` would have made bug 1 visible at once.
- `.scratch/ade-v1/requirements.md`: F063, F064, F065, F066, F068 and F069
  can move to accepted. F067 stays open.
