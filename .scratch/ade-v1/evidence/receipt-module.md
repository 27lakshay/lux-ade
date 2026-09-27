# receipt-module

Status: returned
Type: slice evidence
Branch: claude/wf_3f97c965-a4e-3
Worker: Phase 0 parallel build, slice receipt-module
Requirements: none (foundation for the effect-command envelope, issue 11)

## Outcome

Added `crates/ade-daemon/src/receipts.rs`, the shared receipt module. It works on any
rusqlite `Connection` or `Transaction`: `ensure` creates the `operations` table, `begin`
admits an operation (New, Replay, Conflict, Expired), `settle` records its state and
result, and `prune` turns receipts older than 30 days into expired markers.
`fingerprint` is SHA-256 over canonical JSON (keys sorted recursively, top-level
`operation_id` removed, no whitespace). `sessions.sqlite` gets the table in migration 17.
No feature was migrated to it.

## Operation tiers

None added or changed. The module serves effect commands in Phase 1.

## Checks

- `pnpm check:static`: pass
- `cargo fmt --all --check`, `cargo clippy -p ade-daemon --all-targets -D warnings`,
  `cargo nextest run -p ade-daemon --profile ci`: pass
- In-process tests added: `crates/ade-daemon/src/receipts.rs` (canonicalization,
  fingerprint stability, the four admission outcomes, rollback, status round trip)

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 25 | 5 | 10 | 0 |

## References

- docs.rs rusqlite 0.40.2 `Transaction` (Deref to `Connection`, `OptionalExtension`), studied.
- No reference repos used.

## Open

- Schema 17 moved every exact-version gate: `bin/control/backup.rs` (17),
  `bin/control/main.rs` restore binding (17), `scripts/managed_backup.py` (1..17),
  `scripts/runtime.py` (1..17), `scripts/profiles.py` (12..17).
- Two E2E specs held literal schema numbers and were edited, not run:
  `e2e/specs/attachment-retention.spec.ts` expects schema 17;
  `e2e/specs/local-profiles.spec.ts` now uses 18 as its future version.
- The expired marker uses status `expired`, outside the five operation states. It is
  internal: `Status::parse` rejects it and `begin` maps it to `Admission::Expired`.
- The review and lifecycle databases must call `receipts::ensure` when Phase 1 slices
  adopt receipts. It does not change their `user_version`, so backup gates stay as is.
- `.scratch/parallel-build/research/07-backup-implementation.md` still says schema 16.
