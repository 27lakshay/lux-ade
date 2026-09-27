# Audit minor fixes: storage-backup

Status: returned
Type: audit fix evidence
Area: storage-backup (`ade-control backup`, `ade-control runtime bind`)

Both findings were traced in the current code and confirmed before fixing.
`pnpm check:static` passes.

## 1. The browser library was neither backed up nor declared excluded

Confirmed. `browser_library::Library::open` creates `browser-library.sqlite3`
in the daemon's data directory (`browser_context.rs`, `self.directory`, set at
`server.rs` from the same directory as `sessions.sqlite`). `STORES`,
`COVERAGE` and `EXCLUDED` did not name it, so a backup and restore dropped the
profile's named partitions, imported bookmarks and history, and held captures.

Fix (`crates/ade-daemon/src/bin/control/backup/coverage.rs`):

- Backup format bumps to 4. `browser-library.sqlite3` is a `Sqlite` store,
  unversioned (schema 0), `since: 4`, copied by the existing online SQLite
  backup and checked with `quick_check`.
- Format-4 coverage marks it `backed_up`, and marks `browser-import-staging`
  (the library's transient import copies) `excluded`. `EXCLUDED` adds a line
  for import staging.
- Restore still reads formats 3 and 2. Format 3 keeps its own frozen
  `EXCLUDED_V3` and `COVERAGE_V3`, and a format-3 bundle may not carry the
  library entry. `OLDEST_FORMAT` replaces `PREVIOUS_FORMAT`.
- `validate` required the history index to be absent only for `format >=
  FORMAT`; with the bump that would have skipped the check on format-3
  bundles. It now uses `PROJECTION_EXCLUDED_SINCE = 3`.
- Restore needs no fence for the library: a held capture finishes only when
  its client repeats the same capture ID, and nothing replays on open.

Test: `backup::coverage::tests::the_browser_library_is_backed_up_from_format_4`
checks the daemon's `LIBRARY_FILE` is a backed-up store, that a format-4
manifest with it validates, that format 3 still validates with its own
coverage, and that format 3 refuses the library entry and format-4 coverage.

## 2. Runtime bind rejected a one-behind restore that restore accepts

Confirmed. `supported_schema` accepts `sessions.sqlite` at schema 16 (current
17), and `fence` does not migrate, so the restored database stays at 16.
`runtime bind` required `version == 17` and refused it. The daemon migrates
16 to 17 when it opens (`store/migrations.rs`).

Fix: a pure `backup::bind_verdict(version, fence)` accepts exactly the schemas
`supported_schema` accepts for the current `sessions.sqlite` schema taken from
`STORES` (no hard-coded 17), and requires both fence marks. `main.rs` calls
it. The refusal text is now "Only a fenced restore of a supported schema can
bind a fresh runtime home"; nothing matched the old text.

Test: `backup::tests::bind_accepts_every_schema_restore_accepts_and_needs_the_fence`
binds current and one-behind, and refuses two behind, the future schema, the
pre-fence schema and a missing fence mark.

## Not done

- No live backup-restore-bind run with a real profile; the E2E suite is paused
  by the test policy.
- The legacy E2E specs that assert backup manifests were not updated; they are
  not run.
