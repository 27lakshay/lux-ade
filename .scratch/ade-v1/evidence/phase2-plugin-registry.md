# phase2-plugin-registry

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-7
Worker: Phase 2 round B workflow, slice plugin-registry
Requirements: F051 (backend foundation, advanced, not accepted), F059 (records and settings, advanced, not accepted)

## Outcome

The daemon now has a plugin registry. It installs pinned artifacts from a local
directory, a package archive or a Git commit, and records each one in the
profile's `sessions.plugins.sqlite3`. Installed files go under
`sessions.plugins/artifacts/<id>/<version>-<digest>/`. Each plugin tracks three
separate identities: the artifact version and source pin, a monotonic activation
generation, and a data schema.

Enabling a plugin verifies the artifact digest. It then persists the next
generation and creates an activation that owns the manifest's command and panel
registrations. The activation registry removes a registration only for the
activation that owns it. Late cleanup from generation 1 therefore cannot remove
anything generation 2 holds. Plugins get namespaced records, with revisions and
compare-and-set, and settings that must be declared in the manifest.
`credential_ref` settings hold references only. No plugin host process or UI
slot exists yet. `PluginManifest` (`ade-plugin.json`) is the schema those hosts
will read.

Reliability rules:

- `plugin.install` and `plugin.uninstall` each have one commit point: the
  transaction that writes the plugin row also settles the receipt.
- A receipt left open by a crash is settled `not_applied` when the registry
  opens. This is provable, because the row and the settle commit together.
- A failure before commit is stored as the settled outcome. A replay with the
  same ID returns the same failure and never re-runs the effect.
- A replay of an operation still running returns `in_progress`.
- Replacing an artifact requires the plugin to be disabled, which drains it.
- An artifact whose data schema is lower than the stored one is refused, because
  rolling back code does not roll back data. Purging the data is the only way
  back.
- A registry that fails to open does not stop the daemon. Plugin operations
  then return `Plugin registry is unavailable`.

Pure logic:

- `crates/ade-daemon/src/plugins/manifest.rs`: manifest validation, namespace
  rules, setting value checks and `admit_data_schema`.
- `crates/ade-daemon/src/plugins/activation.rs`: `Registry`, `fence` and
  `activate_all`, which checks every conflict before it changes anything.

## Operation tiers

| Operation | Tier |
|---|---|
| `plugin.list` | query |
| `plugin.inspect` | query |
| `plugin.install` | effect command (receipt, daemon fingerprint) |
| `plugin.uninstall` | effect command (receipt, daemon fingerprint) |
| `plugin.enable` | idempotent command (enabling an enabled plugin changes nothing) |
| `plugin.disable` | idempotent command |
| `plugin.record.get` | query |
| `plugin.record.list` | query (refuses more than 1000 records) |
| `plugin.record.put` | idempotent command (optional `expected_revision`) |
| `plugin.record.delete` | idempotent command (optional `expected_revision`) |
| `plugin.setting.list` | query |
| `plugin.setting.set` | idempotent command |

The CLI area is `apps/cli/src/commands/plugins.ts`: `ade plugin
list|inspect|install|uninstall|enable|disable|record|setting`. Install and
uninstall require `--request-id`.

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build,
  typecheck, Fallow, JS build, JS pure tests, Clippy, legacy Rust tests).
- In-process tests added:
  - `crates/ade-daemon/src/plugins/manifest.rs`: 6 tests.
  - `crates/ade-daemon/src/plugins/activation.rs`: 5 tests.
  - `crates/ade-daemon/src/plugins/artifact.rs`: 1 test, on Git argument
    safety.
  - `crates/ade-core/src/contract/plugins.rs`: 3 contract round-trip tests.
- A manual smoke run, not committed, drove a real `ade-daemon` through the CLI
  with fixture plugins. It confirmed each of these:
  - An incompatible manifest is rejected.
  - Install succeeds, and a replay with the same ID returns the stored reply.
  - A reused ID with a different payload returns `conflict`.
  - Enable twice gives one generation. A restart re-activates the plugin at
    generation 2.
  - Replacing an enabled plugin is refused.
  - Record compare-and-set conflicts are refused, and so is a setting of the
    wrong type.
  - A data-schema downgrade is refused.
  - A Git install with the wrong commit pin is refused, and one with the right
    pin succeeds.
  - A package install with the wrong SHA-256 is refused, and one with the right
    digest succeeds. It gives the same tree digest as the local and Git sources.
  - Uninstall without a purge keeps the data. A later purge works after
    uninstall.
  - A generation stays monotonic across uninstall.
  - A receipt left `accepted` by a crash is answered `not_applied`.

Verified only statically: artifact tamper detection on enable and restore,
garbage collection of the artifacts of uninstalled plugins, the
`Plugin registry is unavailable` path, and Git clone timeouts.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 0 | 15 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/shared/plugins/plugin-manifest.ts`,
  `plugin-id-format.ts`, `plugin-path-safety.ts`: pattern for a closed manifest
  schema, rejection before activation, and path segment rules. No code copied.
- Orca, `src/main/plugins/plugin-command-registry.test.ts` (per-activation
  cleanup): pattern. Studied through the reference map; no code copied.
- OpenCode-v2, `packages/core/src/plugin.ts`: activation-scoped cleanup pattern.
  No code copied.
- `crates/ade-daemon/src/receipts.rs` and `review.rs`: the receipt admission and
  interrupted-receipt handling this slice follows.

## Open

- **Needs E2E later (F051 and F059 acceptance):**
  - install, enable, disable and remove through the running app with visible
    status;
  - UI slots;
  - backend and provider hosts that load entry points and register dynamic
    handles (`Registry::unregister` exists for them);
  - old-worker leases across an update (04-S11).
- **Needs a coordinator change:** `sessions.plugins.sqlite3` and
  `sessions.plugins/artifacts` are not yet in the backup file list in
  `crates/ade-daemon/src/bin/control/backup.rs`. F059 requires that managed
  records take part in backup. That change touches backup version pins, so this
  slice left it alone.
- **Not built:**
  - blobs;
  - credential storage (a `credential_ref` only names one);
  - per-plugin quotas beyond the 64 KiB record limit and the 1000-record list
    limit;
  - an operation to prune unused old artifact versions. They are kept for future
    leases.
- **Sources:**
  - Package sources are local archives only. There is no registry fetch.
  - Git clones run with `GIT_TERMINAL_PROMPT=0`, hooks disabled and no
    submodules.
  - Artifacts with symbolic links are refused.
- **Error delivery:** plugin errors carry codes the client knows
  (`invalid_request`, `conflict`, `in_progress`, `not_applied`,
  `outcome_unknown`), but the client still reports their delivery as `unknown`.
- **Shared file:** `apps/cli/src/index.ts` needs three one-line additions (the
  import, the usage fragment and the command area). They could not fit on one
  line.
