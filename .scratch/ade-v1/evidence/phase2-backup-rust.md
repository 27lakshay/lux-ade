# Phase 2: backup-rust

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-3
Worker: Phase 2 parallel build, backup-rust worker
Requirements: F050 and R014 (backup and restore reliability), toward ticket 07 (retire `managed_backup.py`)

## Outcome

Rust `ade-control backup` now has the five behaviours that only
`scripts/managed_backup.py` had. All changes are in
`crates/ade-daemon/src/bin/control/backup.rs`:

- **Attachment integrity.** Every `sessions.sqlite` schema check (create source,
  created copy, inspect, restore, resume) verifies each attachment row. The
  metadata must name the row; a live payload must equal its declared `size`; a
  discarded payload must be empty; the row must have a generation. Messages match
  Python: `Attachment record is invalid`, `Attachment generation is invalid`,
  `Attachment payload is incomplete`.
- **Backup pause hook.** It holds the online copy of `sessions.sqlite` after the
  first page. The hook writes `sqlite-backup-active` to the signal file and waits
  up to 10 s for the release file. It needs a debug build (`cfg!(debug_assertions)`,
  so release and packaged builds compile it out) and `ADE_E2E_BACKUP_PAUSE_ENABLED=1`
  plus absolute `ADE_E2E_BACKUP_PAUSE_SIGNAL` and `ADE_E2E_BACKUP_PAUSE_RELEASE`.
  A half-configured pause is refused, not ignored.
- **Destination guard.** `backup create` refuses a destination inside the data
  directory it copies. `profiles backup-backend` refuses one inside the profile
  directory or its data directory. Both compare canonical paths.
- **Pre-schema-12 rejection.** A `sessions.sqlite` below schema 12 fails with
  `Restore requires a schema-12 backup with an execution fence; …`. The accepted
  range is unchanged: the current schema and one behind.
- **Lifecycle recovery fields.** Restore now sets `recovery:
  "inspect_repository_before_retry"` and `finished_at` (ms) on running lifecycle
  operations it marks `interrupted`. The error text matches Python. The daemon
  reads `recovery` (`worktrees.rs`).

`scripts/browser_lease.py` is deleted. Nothing referenced it; `ade-control
browser-lease` replaced it.

## Operation tiers

No daemon operations were added or changed. `ade-control backup create|inspect|restore`
and `profiles backup-backend|restore-backend` are local CLI commands, not wire
operations, so no contract was added.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-daemon/src/bin/control/backup.rs` (`mod tests`):
  schema range and the named pre-fence rejection, attachment verdicts, the
  destination guard, the pause gate, and the lifecycle interrupt fields.
- Manual smoke against a real daemon-created schema-17 data directory (debug
  build): nested destination refused; pause wrote the signal and nothing
  published before release; restore succeeded; a doctored short attachment
  payload refused with `Attachment payload is incomplete: a1` and left no stage
  directory.

Verified only statically or in-process:

- The restore-side lifecycle rewrite (only the pure `interrupt` decider is tested).
- The `profiles backup-backend` guard (only the shared `outside` decider and the
  plain `backup create` path were exercised).
- The pause hook while the daemon writes concurrently.

Needs E2E later (when the 19 Python-backed cases switch to `ade-control`):

- `managed-backup-core` (schema-11 rejection, attachment checks),
  `attachment-retention` (pause during reclaim; set `ADE_E2E_BACKUP_PAUSE_ENABLED=1`),
  `local-profiles` (nested destination), `restored-workspace-fence`,
  `restored-workspace-rebind`.
- The schema-12 rebind case in `restored-workspace-rebind` still cannot pass: the
  range stays current-and-one-behind (16–17), per this slice's instructions.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 25 | 5 | 10 | 0 |

## References

- None. `08-reference-map.md` has no backup reference. The behaviours were
  ported from ADE's own `scripts/managed_backup.py` and `scripts/profiles.py`;
  no third-party code was adapted.

## Open

- Decision D15 (restore range) remains open; option A in ticket 07 research
  would widen the range to 12–current.
- Not ported (optional hardening no spec asserts): stable-read retry for
  `empty.toml`, duplicate-key JSON rejection, and declared `consistency` and
  `limitations` in the manifest.
- The existing `ADE_E2E_RESTORE_PUBLISHED_*` hook is still ungated in release
  builds. I left it alone because `e2e/packaged/macos.spec.ts` uses it against
  the packaged binary.
- No shared-file changes and no migration needed.
