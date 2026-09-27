# skill-retention

Status: returned
Type: slice evidence
Branch: claude/wf_5d2276b8-0c2-2
Worker: ADE parallel build, slice skill-retention
Requirements: F138 (advanced; every backend part now has a passing spec, display remains)

## Outcome

Retention now reclaims skill bundle files that no installed skill
references. `skill.remove` and a replacing `skill.install` drop only the
catalog row and record a release; the files they leave are `skill_blob`
candidates in `retention.preview` and are removed by `retention.apply` under
the preview's generation. External, adopted-then-released and placed skill
files on disk are never touched.

The new spec found one product bug, now fixed:

- **A second release of the same content replayed a stale apply.** The skill
  blob fingerprint was `count:bytes`, so content orphaned, reclaimed,
  reinstalled and orphaned again produced the same generation as the first
  time. `retention.apply` then replayed the stored result, reported the
  files removed and removed nothing. Each release now gets an ID SQLite never
  reuses (`skill_blob_releases`, `AUTOINCREMENT`), which is part of the
  fingerprint, so every release is a new item.

F138 is not claimed as accepted: its display remains (see Open).

## Acceptance criteria

### F138 Retention and cleanup: unreferenced skill files

| Criterion | Spec | Result |
|---|---|---|
| Uninstall and replace leave the old files; the preview lists exactly those hashes (a removed installed bundle, a replaced version, an adopted external skill released by `skill.remove`), each with its bytes equal to the bundle's `total_bytes`, its release time and a reason; installed bundles are never listed; the generation is stable; CLI parity | `ops3/skill-retention.spec.ts` first test | pass |
| Apply removes exactly the previewed set, reports each item removed with its bytes, leaves the installed bundles complete (`skill.inspect` verifies every blob), and replays after a daemon kill | same | pass |
| External files untouched: the Claude and Codex skill roots in the scratch HOME, an adopted-then-released skill and a placed-then-released copy are byte-identical before and after apply | same | pass |
| A removed bundle installs again, complete, after its files were reclaimed | same | pass |
| A racing install is protected: reinstalling the same content after the preview makes the stale generation refused, and the files stay | `ops3/skill-retention.spec.ts` second test | pass |
| A racing removal after the preview adds a candidate the caller did not see, so the stale generation is refused | same | pass |
| An install racing the apply itself, four rounds: whichever lands first, the bundle stays complete; a refused apply removes nothing; each round's generation is new | same | pass |
| Previously open row in `e2e-ops.md`, "Unreferenced skill files are candidates" | now covered by the rows above; `ops/retention.spec.ts` first test asserts the replaced version is a candidate instead of asserting none appear | pass |

### F138 parts that remain display-only

Every backend part of the register criterion now has a passing spec:
configured retention (`ops3/retention-policy.spec.ts`), referenced and
in-flight data kept, active resources and unresolved claims kept, reclaim
estimates, per-item failures, receipt pruning (`ops/retention.spec.ts`,
`ops/diagnostics.spec.ts`) and unreferenced skill files (this slice). What
remains is UI:

- showing the preview: candidates by kind, reclaim estimates, withheld kinds
  with their reasons, receipt prune status and the observed logs;
- confirming an apply and showing its per-item results and failures;
- editing the policy limits under their revision.

## Operation tiers

No operation was added and no tier changed.

- `skill.install`, `skill.adopt`, `skill.remove`: effect commands; they no
  longer delete unreferenced blobs and record a release instead.
- `retention.preview`: query; `skill_blob` candidates now carry
  `last_activity_at`, the release time.
- `retention.apply`: idempotent command; a skill blob's fingerprint now
  includes its release ID.

## Product changes

- `crates/ade-daemon/src/skills.rs`: new table `skill_blob_releases`
  (created by `ensure_tables`, no migration number). `release_blobs` records
  a release instead of deleting. `write_bundle` clears a leftover blob set of
  the hash it installs, so a damaged leftover never blocks a reinstall.
- `crates/ade-daemon/src/sessions/retention.rs`: the fingerprint includes the
  release ID; apply deletes the release row with the blobs.
- `crates/ade-daemon/src/retention.rs`: doc comment only.
- `e2e/protocol/ops/retention.spec.ts` (outside this area, changed because
  the product behaviour changed): the replaced skill version is now expected
  as a candidate, and the candidate count is 3.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/ops3 e2e/protocol/ops e2e/protocol/catalogs e2e/protocol/backup e2e/protocol/reliability-a`: 147 passed, 1 skipped (existing `fixme`).
- After the final change: `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/ops3 e2e/protocol/ops/retention.spec.ts e2e/protocol/catalogs/skills.spec.ts`: 27 passed.
- `pnpm check:static`: pass (810 Rust tests).
- In-process tests added: none.
- Machine safety: no code or spec here calls the Security framework, the
  `security` tool or `hdiutil`. `pgrep` found no `ade-daemon`, `ade-runtime`
  or `security` process from this worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 25 | 10 | 15 | 5 |

## References

None.

## Open

- F138 display, listed above.
- Leftover blobs have no age grace: they are candidates as soon as the skill
  is removed. Nothing can be in flight, because an install commits its blobs
  and catalog row in one transaction under the lock apply holds.
- Blobs orphaned by a daemon built before this change carry no release row
  and fingerprint with release ID 0. Before this change `skill.remove`
  deleted them, so none are expected.
- Coordinator: `.scratch/ade-v1/progress.md` can move the "unreferenced skill
  files" gap in `e2e-ops.md` to done.
