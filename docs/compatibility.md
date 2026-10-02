# Versions, compatibility and local replacement

ADE has not made a public stable release. A matching desktop, CLI, daemon, runtime and resource
set is the supported distribution unit. The current identifiers come from code:

| Boundary | Identifier | Source |
|---|---|---|
| Client to daemon | `ade-application-v1` | `crates/ade-core/src/protocol.rs` |
| Daemon to runtime | `ade-runtime-v8` | `crates/ade-core/src/protocol.rs` |
| Profile SQLite | Schema 22 | `crates/ade-daemon/src/store/migrations.rs` |

Protocol identifiers describe compatibility; they are separate from the package version and
build hash. The CLI and desktop should use binaries from the same build when changing a wire
contract.

## Profile data before the first release

Under [decision D19](../.scratch/ade-v1/decisions.md), this build creates one profile schema in
a transaction. It reads schema 22 or a new database. It refuses a database at any other schema
version before changing its journal settings. There is no forward migration chain for older
development profiles and no old-format restore support before launch.

When deliberately replacing a development profile after a schema change, preserve the old
profile directory if it may contain data you need, then start a new profile. Do not decrement
`user_version` or change tables by hand to make an old database appear compatible. The
[store tests](../crates/ade-daemon/src/store/tests.rs) cover refusal without mutating an older or
newer database and interruption during fresh schema creation.

This prelaunch rule does not decide post-release upgrades. Before a public release, define the
supported upgrade range, forward migrations, backup requirements and interruption tests against
real released schemas.

## Running-process replacement

`ade-control runtime restart --home PATH` asks the running daemon to stop admitting work,
replaces it under its boot identity and preserves a compatible runtime and its live processes.
Failure to release the database writer lock is reported. `replace-supervisor --stop-active` is a
separate explicit operation that ends active shells and provider processes. Inspect the profile
with the [troubleshooting commands](troubleshooting.md) before either operation.

The controller is not an app updater. Automatic download, signing, rollout and rollback require
a release policy and separate tests. [Build and release](build-and-release.md) lists the current
packaging path and the remaining release verification.

## Native Codex history compatibility

The public worker SDK requires Node 22 or newer and pins Effect and
`@effect/platform-node` to `4.0.0-rc.118`. Bundled Codex uses this same SDK
boundary and an ADE-owned Rust translator for the native app-server protocol.

The installed Codex CLI `0.159.0` reports legacy history mode. Its runtime rejects
`thread/items/list` despite declaring that API in generated schemas, including
with experimental APIs enabled. ADE therefore dispatches by the native history
mode, not by schema presence. File-backed legacy sources stream bounded pages.
Non-file legacy transcripts use a bounded read and refuse `resource_limit` before
decoding an over-budget full response. Modern cursor paging is covered by a
provider-protocol fixture; it is not a claim of installed modern CLI support.

A query-only smoke used Node `24.19.0`, Codex `0.159.0`, an isolated native home
and a 2,215,640-byte rollout through the public SDK worker and owned helper. Five
bounded reads preserved the source byte-for-byte and confirmed worker exit.
No credentials, model request, native submission or session resume were needed.

Native source continuation is oldest-first and forward. Source position is not
ADE sequence. Source size stays unknown when it cannot be measured; zero is a
real empty measurement. See [the worker protocol](provider-worker-protocol.md)
for the 32-item/512-KiB page boundary, pre-decode aggregate reservation, source
identity, durable delivery and epoch fences. Legacy bulk import and
branch-sensitive Claude projection still require a whole source within the
1-MiB decode boundary; they refuse larger inputs rather than partially import
them. Codex file-backed history queries do not have that whole-file limitation.
