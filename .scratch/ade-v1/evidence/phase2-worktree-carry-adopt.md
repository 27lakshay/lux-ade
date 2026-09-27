# phase2-worktree-carry-adopt

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-1
Worker: Phase 2 round D, worktree-carry-adopt worker
Requirements: F064, F065, F068 (advanced, not accepted); 05-S11 (carry and adoption take HostResources claims)

## Outcome

The lifecycle daemon can now carry uncommitted changes from one tree into a
clean ADE-owned tree, create a tree from a ref fetched from a configured
remote, apply explicit per-repository rules for ignored resources, and adopt
a tree only under a confirmed HostResources claim with its physical identity
recorded. A carry saves the changes as a commit under `refs/ade/carry/<hash>`
before the target changes, and cleans the source only after an exact,
verified carry and a re-read that shows the source unchanged. No requirement
is accepted: acceptance needs the E2E evidence in the 05-workspaces spec.

## Operation tiers

| Operation | Tier | Reply | Change |
|---|---|---|---|
| `worktree.carry.preview` | query | `worktree_carry_preview` | new: changed paths, selection, blockers, source `HEAD` |
| `worktree.carry` | effect command (receipt) | `worktree_state` | new: snapshot, save ref, apply, verify, optional source cleanup; `result.carry` |
| `worktree.resources.apply` | effect command (receipt) | `worktree_state` | new: apply resource rules to an owned tree; `result.resources` |
| `worktree.create` | effect command | `worktree_state` | optional `fetch: {remote, ref}`; resource rules run before setup hooks |
| `worktree.configure` | idempotent command | `worktree_state` | config gains `resources: [{path, mode: copy/link/skip}]` |
| `worktree.adopt` | effect command (unchanged wire) | `worktree_state` | holds a shared-use host claim; records device and inode |

Wire compatibility: every new field is optional or omitted at its default.
`worktree.adopt` keeps its request shape; it still has no operation ID (see Open).

## Design

- **Carry (F064).** Admission requires the target to be an ADE-owned tree
  (verified marker), `ready` or unphased, with no lease of this profile, and
  takes an exclusive `use` host claim on the target and a shared one on the
  source. The worker, under the repository lock, re-checks authority, phase
  and listing, requires `git status` in the target to be empty, and selects
  source changes from porcelain v2 status (`--no-renames`). Unmerged paths,
  submodules, unchanged requested paths, unsafe paths, more than 10000
  changes, an unborn `HEAD` or a changed `expect_head` refuse with
  `carry_blocked`. The snapshot is built in a temporary index
  (`read-tree base`, `add -A` on the literal selected paths, `write-tree`),
  so the source's own index and files do not change. `commit-tree` writes the
  commit and `update-ref` with an empty old value creates the ref, which is
  written to the ledger row before the target changes. If the target is at
  the source commit the snapshot tree applies as is; otherwise
  `git merge-tree --write-tree --merge-base` computes a merge, and any
  conflict refuses with `carry_conflict` and applies nothing. The target is
  re-checked clean at the same `HEAD`, then `read-tree -m -u` applies the
  tree. Verification: the target's `write-tree` equals the applied tree and
  status shows only staged changes. Carried changes arrive staged.
- **Source cleanup.** Only when `clean_source` is true, the carry is exact
  and verified, and a second snapshot plus `HEAD` equal the first. Then the
  known paths are reset to the base, paths present in the base are checked
  out, and added files are deleted. A final snapshot must equal the base
  tree; otherwise the source reads `cleanup_incomplete`. A requested cleanup
  that did not happen makes the operation `partial` (`carry_source_kept`).
- **Claims.** A target or source that was handed a change without a read-back
  settles quarantined (`carry_outcome_unknown`); a lost daemon leaves the
  active `use` claim to owner-loss quarantine.
- **Fetched sources (F065, D08).** `worktree.create` with `fetch` accepts only
  a remote listed by `git remote` and a full `refs/…` name without refspec
  characters. The local ref `refs/ade/fetched/<hash>` is written to the
  ledger before `git fetch --no-tags --no-write-fetch-head`; the new branch
  starts at the fetched commit. No pull-request state is read or managed.
  The CLI maps `--pr N` to `refs/pull/N/head` on `origin`; GitLab users pass
  `--fetch-ref refs/merge-requests/N/head`.
- **Adoption (F065).** Adoption now refuses a path being removed, takes a
  shared `use` host claim for the grant (refused while any profile creates or
  removes the path, or while the registry is blocked), re-checks the path's
  canonical form and device/inode under the claim, and records device and
  inode with the ownership marker. Authority checks compare the recorded
  identity when present, so a replaced directory loses authority.
- **Ignored resources (F068).** Rules are literal relative paths (no globs,
  `..` or `.git`, at most 64, non-overlapping). A rule acts only when the
  path exists in the primary checkout, `git check-ignore` confirms it is
  ignored, the destination does not exist, and both parents resolve inside
  their trees. `copy` creates every file, directory and link new (never
  replaces), refuses copies over 2 GiB or 200000 entries, and does not follow
  links. `link` creates a symbolic link to the primary checkout's path, so
  cleanup removes only the link and the external resource survives.
  `skip` is reported. An unsafe or failed rule stops creation before setup
  hooks with the tree kept in `setup_failed` (`resource_failed`).

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-daemon/src/worktrees/carry.rs`
  (status parsing, selection and blockers, target verification, cleanup
  decisions, carry status, ref names, merge-tree output, name-status, target
  phases, fetch validation), `crates/ade-daemon/src/worktrees/resources.rs`
  (rule validation, rule plans, limits, phases),
  `crates/ade-core/src/contract/worktrees.rs` (new request, reply and result
  shapes against the generated schema).

## Verified only statically

The Git command sequences (temporary-index snapshot, `commit-tree`,
`update-ref`, `merge-tree`, `read-tree -m -u`, `reset`/`checkout` with
`--pathspec-from-file`, `ls-files`, `check-ignore`, `fetch`) compile and
their outputs are parsed by tested pure functions, but none ran against a
real repository in this slice. The worker sandbox refused Git experiments
outside the worktree, so the exit-code and output assumptions (merge-tree
exit 1 on conflict, `reset -q` exit 0 with paths) come from Git
documentation, not observation.

## Needs E2E or UI later

- F064: preview and carry selected changes; conflict leaves target and
  source untouched; `clean_source` after an exact carry; an edit racing the
  cleanup; daemon killed after the ref is written (receipt `interrupted`,
  target claim quarantined, ref present).
- F065: adopt under another profile's removal claim (refused); adopt a
  replaced directory; `worktree new --pr N` against a fixture remote with
  `refs/pull/N/head`; an unknown remote or URL refused.
- F068: `.env` copy, `node_modules` link, conflict at the destination, a
  tracked path named by a rule (`not_ignored`), a symlinked parent
  (`unsafe`), cleanup removing a linked tree while the primary's
  `node_modules` survives.
- UI for the preview, conflicts and resource results.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 10 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `orca/src/main/git/worktree-include-file.ts`, `orca/src/main/ipc/worktree-symlinks.ts` — pattern: literal paths only, ignored-only, no clobbering copies, link versus copy semantics. No code copied.
- Paseo @ ade-evaluation-2026-09-24, `paseo/packages/server/src/server/workspace-create-worktree-source.e2e.test.ts`, `worktree-core.posix.test.ts` — studied: fetched `refs/pull/N/head` as a creation source.
- git-scm.com `git-merge-tree` documentation — `--write-tree -z --name-only --no-messages --merge-base` output format.

## Open

- `worktree.adopt` is declared an effect command but carries no operation ID
  or receipt; adding one needs a wire decision (optional `operation_id`).
- `refs/ade/carry/*` and `refs/ade/fetched/*` are never pruned; a retention
  rule or explicit drop command is still needed.
- `worktree.setup` after a `resource_failed` creation does not re-apply
  rules; run `worktree.resources.apply` first.
- Combining create and carry in one operation (carry into a new tree
  created from the source `HEAD`) is left to callers: `worktree new --base
  <source HEAD>` then `worktree carry`.
- No shared-file changes are needed from the coordinator.
