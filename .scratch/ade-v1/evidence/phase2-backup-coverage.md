# Phase 2: backup-coverage

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-1
Worker: Phase 2 round C parallel build, backup-coverage worker
Requirements: F050, R014 and D15 (declared backup coverage); F059 (plugin
records and settings take part in backup)

## Outcome

`ade-control backup` now covers the stores added in Phase 2 and declares every
store it leaves out. It writes backend format 3 and still restores format 2.
Nothing here fully accepts a requirement. F050 and R014 still need E2E proof.

Per-store decisions, recorded in the manifest's `excluded` list and a new
`coverage` list:

| Store | Where it lives | Decision |
|---|---|---|
| Activity and notification deliveries | `sessions.sqlite` | Backed up by the existing online copy |
| MCP catalog (`mcp_servers`) | `sessions.sqlite` | Backed up by the existing online copy |
| Skill catalog and bundle blobs | `sessions.sqlite` | Backed up. Create, inspect and restore check that every bundle has each blob its manifest names, with that blob's digest and size |
| `sessions.plugins.sqlite3` | data directory | Backed up (new SQLite entry, unversioned, schema 0) |
| `sessions.plugins/artifacts/` | data directory | Backed up. A new `directory` entry lists each file's path, size, SHA-256 and executable bit |
| `sessions.plugins/staging/` | data directory | Excluded, because it is install scratch |
| History search index (`history_fts`, `history_docs`, `history_journal`, their triggers) | `sessions.sqlite` | Rebuilt. The copy drops these tables and sets `history_index_state.version=0`, then runs VACUUM. The daemon rebuilds the index under a new epoch |
| HostResources registry (`host-resources.sqlite3`, claims, owner locks) | profiles home, or the data directory when the daemon is unmanaged | Excluded, because it is owned by the host, not the profile. Restore deletes `host_resources_binding` in `lifecycle.sqlite3`, so the restored profile binds afresh. Otherwise the daemon would block it as "registry replaced" |

Format 3 changes:

- **Directory entries.** The entry `size` is the sum of its files. Its
  `sha256` is the plugin artifact tree digest (the same scheme as
  `plugins/artifact.rs::walk`), so the manifest proves each installed plugin's
  `artifact_digest`. Inspect requires the bundle directory to hold exactly the
  listed files.
- **Registry and artifact consistency.** The registry is copied before its
  artifacts. Each plugin row must then find its whole artifact, with the
  recorded digest, in the copied files. If a row cannot, create fails with
  "retry the backup, or reinstall the plugin", and so does inspect.
- **Artifact paths on restore.** The daemon records `artifact_path` as an
  absolute path. Restore rewrites it to the restored data directory; without
  this, the restored profile would load the source profile's artifacts.
- **Unknown stores.** Any entry under `sessions.plugins/` other than
  `artifacts/` and `staging/` fails the backup. A store added there later
  cannot be left out silently.
- Every SQLite copy is switched to `journal_mode=DELETE`, so the hash covers
  one self-contained file.
- Restore accepts format 3 and format 2. Each format has its own exclusion
  list. Restore of a format-2 bundle also drops the history index. The schema
  rule is unchanged: the current schema or one behind.

The code is in `crates/ade-daemon/src/bin/control/backup.rs`. A new pure
module, `crates/ade-daemon/src/bin/control/backup/coverage.rs`, holds the store
table, exclusions, coverage, entry selection (`decide`), manifest validation
(`check_manifest`), the tree digest, the artifact rebase, and the skill and
projection verdicts.

## Operation tiers

No daemon operations were added or changed. `ade-control backup
create|inspect|restore` and `profiles backup-backend|restore-backend` are
local CLI commands, not wire operations. The JSON envelopes keep their shape.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  `crates/ade-daemon/src/bin/control/backup/coverage.rs` (`mod tests`, 8 tests).
  They cover entry selection, the tree digest scheme, the artifact path rebase,
  the plugin digest verdict, the skill blob verdict, the history projection
  verdict, manifest format, exclusion and coverage checks, and directory-entry
  sums and digests.
- Manual smoke, not checked in, with debug binaries: a real daemon created a
  profile; a plugin was installed by hand; then:
  - create gave a bundle with two artifact files and no history tables
  - inspect passed
  - restore rewrote `artifact_path` and kept the executable bit
  - the restored daemon rebuilt the index (version 1, epoch 2)
  - a tampered artifact failed inspect, and so did an extra file
  - an unknown `sessions.plugins/private` failed create, and so did a missing
    artifact
  - a hand-made format-2 bundle restored
  - `host_resources_binding` went from 1 row to 0

Verified only statically or by that manual smoke: all of the above. No E2E
ran, as AGENTS.md directs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 10 | 15 | 0 |

## References

- None copied. The tree digest scheme matches ADE's own
  `crates/ade-daemon/src/plugins/artifact.rs::walk`. It was matched, not
  adapted.
- `.scratch/parallel-build/research/07-backup-implementation.md`, studied for
  D15 and the restore range.

## Open

- **Legacy E2E assertion.** `e2e/specs/native-control.spec.ts:39` expects
  `backup inspect` to report `format_version` 2. It now reports 3. The
  assertion should change to 3 when E2E work returns. It was not edited here
  because legacy E2E is frozen.
- **E2E coverage still needed:**
  - a backup taken while a plugin installs or uninstalls
  - an enabled plugin re-activating after restore, through public reads
  - history search working after the rebuild
  - a skill bundle surviving restore
  - a restored profile claiming HostResources on the same host and on a new
    host
- **Plugin-private files.** None exist yet. When the plugin host gives plugins
  a private directory, it must go under `sessions.plugins/`, and `decide` must
  gain a rule for it. Until then, create refuses the backup, so it fails
  closed.
- **Search cursors.** Search cursors issued before a restore expire, because
  the rebuild raises the index epoch. Restored profiles are new identities,
  so no client should hold one.
- **No UI, CLI (`apps/cli`) or daemon RPC starts a backup yet.** This is
  unchanged from backup-rust.
- **Coordinator: `docs/compatibility.md`.** It should record backend backup
  format 3, with format 2 still readable.
