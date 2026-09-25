# Versions, compatibility, and local upgrades

lux-ade is currently version 0.1.0 and is not a public stable release. A matching set
of client, daemon, runtime, and resources is the supported distribution unit.
Public delivery, signing identity, and release ownership remain deferred.

## Current compatibility identifiers

| Boundary | Current identifier | Source of truth |
|---|---|---|
| Client to daemon | `ade-application-v1` | `ade-core/src/protocol.rs` |
| Daemon to supervisor | `ade-runtime-v8` | `ade-core/src/protocol.rs` |
| SQLite data | `PRAGMA user_version = 7` | `ade-daemon/src/store.rs` |
| Executable identity | Content hash and Mach-O UUID | Packaged `Resources/build-manifest.json` |

Protocol identifiers describe compatibility, not the app marketing version.
The Python runtime controller mirrors the two protocol identifiers and must
change with them. Build hashes distinguish binaries with the same protocol.
A running compatible daemon may stay alive when a new client starts; the
controller reports the new build rather than silently stopping live work.

## Change rules

Additive optional fields may keep the current protocol when old and new peers
both handle their absence. Changing operation meaning, required fields, framing,
or lifecycle guarantees requires a new protocol identifier and compatibility
tests. Unknown provider events must not corrupt the last healthy projection.

Database changes require a numbered forward migration and a test starting from
the oldest affected schema with representative data. Migrations use SQLite
transactions. A database newer than this build understands is refused before
changing its journal settings. Do not implement a downgrade by decrementing
`user_version` or silently discarding new data.

A release must keep its dependency lockfiles, patches, build manifest, and
matching debug symbols. Symbols are stored separately from stripped app copies.
A reported crash is investigated against the executable UUID, not only 0.1.0.

## Local replacement behavior

`scripts/runtime.py restart` asks the current daemon to stop admitting work and
prepare a restart, fenced by its boot identity. It waits for the database writer
lock, starts the replacement, and verifies that the supervisor identity remains
the same. Failure to release the lock is reported without forcing a replacement.
This preserves supervisor-owned processes when the versions are compatible.

`replace-supervisor --stop-active` is an explicit different operation. It ends
live shells and providers through the identity-checked supervisor API. Closing a
pane or client never implies this operation.

The controller writes its profile metadata with an atomic file replacement.
This is not an app updater. There is no automatic download/install channel or
automatic rollback after a database migration. If startup fails, preserve the
profile and use a compatible build; inspect diagnostics before retrying.

## Release checks still required

- Verify older/newer peer combinations for each changed protocol.
- Test process interruption before and after each migration or replacement step.
- Choose a public update transport and artifact-signing policy before adding
  automatic installation.
- Test signed releases on a clean supported Mac, including interrupted updates.

See [Build and release](build-and-release.md) for packaging commands and
[Task lifetimes](task-lifetimes.md) for client cleanup and deadlines.

## Migration failure evidence

Store migrations commit one numbered step at a time. An error in a later step
rolls back that step; previously committed forward steps can remain. This is not
an automatic database downgrade or a whole-upgrade rollback policy.

The daemon store regression suite exercises a schema-v5 fixture with a saved
draft, queued prompt and conversation. A trigger fails migration 6 after its DDL
runs; the test verifies that the new table/columns, migration-history row and
version bump all roll back while saved data remains readable, then removes the
fixture trigger and completes a successful retry. A separate test starts the
actual migration in a child test process and kills it at an uncommitted checkpoint.
SQLite recovery restores the same invariants and the next open completes the
upgrade. The checkpoint exists only in test builds; production migration code
has no environment-controlled interruption hook.

A future-schema fixture also verifies byte-for-byte database preservation and
unchanged DELETE journal mode when startup refuses schema 99. These regressions
cover one interrupted transaction, explicit SQL failure and unsupported startup;
they do not simulate power loss, every migration boundary, or full application
installation rollback. Other migration tests cover successful upgrades from
older supported fixtures.
