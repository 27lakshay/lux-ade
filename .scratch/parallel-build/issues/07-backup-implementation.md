# Which backup implementation ships?

Status: closed
Type: wayfinder ticket (research, AFK)
Label: wayfinder:research
Map: [Parallel build](../README.md)
Assignee: claude (research subagent, 2026-09-27)
Blocked by: none

## Question

Should backup live in `scripts/managed_backup.py` or in `crates/ade-daemon/src/bin/control/backup.rs`? What does each cover, and who calls each: E2E specs, the packaged app, the CLI?

Diff their capabilities, formats and restore compatibility. Check whether the packaged app can run Python at all. Recommend which one survives, what the other's callers must switch to, and which E2E evidence must be migrated before the other is retired.

## Comments

- 2026-09-27 — Research: [07-backup-implementation](../research/07-backup-implementation.md). Keep Rust `ade-control backup`; retire `scripts/managed_backup.py` and the backup actions in `profiles.py`. The packaged app cannot run Python (commit `ccb0bad`), and the two formats (1 and 2) are mutually unreadable. Before the 19 Python-backed E2E cases switch, Rust needs: attachment integrity checks, a backup pause hook, a guard against a destination inside the profile, a restore schema range, and the lifecycle `recovery`/`finished_at` fields. `scripts/browser_lease.py` is unused and can go now. `runtime.py` and `profiles.py` duplicate `ade-control` in the same way.
- Open product question, routed to D15 (not this map): should restore accept schemas 12 through current (researcher's pick, keeps backups restorable after upgrades), or current only?
