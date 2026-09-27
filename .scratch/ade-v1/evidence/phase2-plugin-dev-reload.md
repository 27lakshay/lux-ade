# phase2-plugin-dev-reload

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-8
Worker: Phase 2 round E workflow, slice plugin-dev-reload
Requirements: F139 (plugin development, backend part, advanced, not accepted); F060 (backend reload and inspection, advanced, not accepted); 04-S11 (leases of old generations, backend groundwork only, not accepted)

## Outcome

A plugin installed from a local directory can now enter development mode. The
daemon scans the source directory every 250 ms. When the scan changes and then
stays quiet for the debounce, the daemon copies the tree exactly as
`plugin.install` does and starts a new activation generation of the plugin. The
debounce defaults to 300 ms, and a source that never settles still reloads 10 s
after its first change. The old generation's backend host drains its open calls
for up to 15 s. Its `deactivate` then runs with its 5 s bound, and its process
group is killed. The new host starts at once. Every activation is now recorded
as a generation with its artifact, origin and state. A superseded generation
stays until nothing holds it: a draining host or a provider-session lease.

Reliability rules:

- A reload never tears down the running generation before the new one is
  committed. These reloads leave the current generation running and say why:
  - A copy fails, or the manifest is invalid: `failed`.
  - Another plugin owns a registration: `refused`.
  - The source declares a different plugin ID: `refused`.
  - The data schema would drop below the stored schema: `refused`.
  - The data schema would rise while any provider session holds a lease:
    `refused`.
- A copy that raced a write is discarded. The watcher compares the source's
  metadata fingerprint before and after the copy. The change then waits for the
  next quiet period.
- A copy whose digest matches the installed artifact changes nothing. The
  reload reports `unchanged`.
- Order of a reload:
  1. Under the registry lock, check the registry for conflicts first.
  2. Place the artifact.
  3. Commit the plugin row, the generation counter and the generation record
     in one transaction.
  4. Make the new generation current in the registry.
  5. Remove the old generation's leftover registrations through the old
     activation. This late cleanup cannot touch the new one.
- A late invocation for the old generation cannot start its host again.
  `Hosts::supersede` fences every generation up to it, and scheduled crash
  restarts now respect that fence too.
- A newer generation adopted through `plugin.command.invoke` no longer kills the
  older host outright. The slot hands the older host to the same drain.
- A call still open when the drain grace ends is cut off and settles as
  `outcome_unknown`. It never settles as done.
- Development mode survives a daemon restart. On open, the watcher resumes for
  every plugin still enabled. Its first scan counts as a change, so edits made
  while the daemon was down are picked up. Disabling a plugin ends development
  mode.
- Uninstalling a plugin that provider sessions still lease is refused with
  `conflict`.
- Artifact directories that neither the installed row nor a held generation
  references are removed. They are compared by directory name, so a moved
  profile never loses a referenced artifact. The last 20 retired generations are
  kept for inspection.
- A background reload sets a flag. The hook dispatcher then refreshes hook
  subscriptions to the new generation on its next pass.

Pure logic, in `crates/ade-daemon/src/plugins/dev.rs`:

- `Debounce::observe`: the trailing debounce with a cap.
- `debounce_ms`: the allowed range.
- `copy_is_consistent`.
- `drain_step`: wait, deactivate (forced or not) or exited.
- `settle`: current, leased, draining or retire.
- `reload_schema`.

`Registry::refusal` in `activation.rs` is the side-effect-free conflict check.

## Operation tiers

| Operation | Tier |
|---|---|
| `plugin.dev.enter` | idempotent command. Entering again only updates the debounce |
| `plugin.dev.leave` | idempotent command. Leaving when not in development mode succeeds |
| `plugin.generation.list` | query. It persists the retirement of generations nothing holds and removes their unreferenced artifact directories. It never starts or stops a host |
| `plugin.disable` | idempotent command, unchanged on the wire. It now also ends development mode and settles generations |
| `plugin.uninstall` | effect command, unchanged on the wire. It is now refused while provider leases exist |

CLI: `ade plugin dev enter PLUGIN_ID [--debounce-ms N]`, `ade plugin dev leave
PLUGIN_ID` and `ade plugin generations PLUGIN_ID`, in
`apps/cli/src/commands/plugin-dev.ts`.

New SQLite tables in `sessions.plugins.sqlite3`, created by
`plugins/reload.rs` with `CREATE TABLE IF NOT EXISTS`:

- `plugin_dev`
- `plugin_generations`
- `plugin_provider_leases`

## Checks

- `pnpm check:static`: pass on the final commit.
- In-process tests added:
  - `crates/ade-daemon/src/plugins/dev.rs`: 6 tests.
  - `crates/ade-daemon/src/plugins/activation.rs`: 1 test. It covers a reload
    that keeps, adds and drops IDs, plus late cleanup.
  - `crates/ade-core/src/contract/plugins.rs`: the round-trip tests cover the
    three new operations.
- A manual smoke run, not committed, drove a real `ade-daemon` and
  `ade-runtime` through the CLI with a fixture backend plugin. It confirmed each
  of these:
  - After `dev enter`, one generation is `current`.
  - A slow invocation was running on generation 1 when the backend source was
    edited. Generation 2 became current, and generation 1 showed `draining`.
    The slow invocation completed on generation 1 with the old value, not as
    unknown. Then an invocation ran on generation 2 with the new value.
  - The old host's `deactivate` ran after its call finished. The log tail
    shows "draining 1 open call(s)", then "deactivate v1".
  - A broken manifest reported `failed` with the parse error. Generation 2 kept
    serving.
  - After the source was fixed, generation 3 activated with the new version.
    Only its artifact directory remained on disk.
  - `dev leave` then `disable` retired generation 3.
  - After a daemon restart, development mode resumed (`watching: true`). An
    edit made while the daemon was down reloaded as generation 4, after the
    `restore` generation 3.

Verified only statically:

- Provider leases. `Plugins::lease_provider` and `Plugins::release_provider`
  exist, but nothing calls them yet: there is no plugin provider-worker runtime.
  Leased retention and the schema refusal while leased are checked only by the
  pure `settle` and `reload_schema` tests. Every generation list shows
  `provider_leases: 0`.
- The forced end of a drain after 15 s.
- The 10 s debounce cap under continuous writes.
- The refusal for another plugin's registration.
- The discard of a copy that raced a write.
- The refusal for a changed plugin ID.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 0 | 20 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/main/plugins/plugin-dev-watcher.ts` (MIT): pattern. A trailing debounce over source changes, and one full refresh after the watcher is interrupted. ADE adds a cap on the total wait and polls a metadata fingerprint instead of a Parcel watcher process. No code copied.
- OpenCode-v2, `packages/core/src/plugin.ts` (MIT): studied again for activation-scoped cleanup. No code copied.
- `crates/ade-daemon/src/plugins/{activation,host,supervision}.rs`: the generation fencing this slice extends.

## Open

- **Needs E2E later (F139, F060):**
  - Reload a backend plugin during an active invocation through the running
    app. Show the old call finishing and new work reaching the new generation.
  - Show a broken reload leaving the old generation serving.
- **Needs the provider runtime (04-S11):** call `lease_provider` when a plugin
  provider worker starts a session, and `release_provider` when it ends. Then
  prove through E2E that a reload keeps the old worker and its artifact while
  the session lives.
- **Not built:**
  - UI and renderer hot reload, Electron main restart and component-state
    previews. These are the renderer parts of F139.
  - A manual "reload now" operation.
  - Native file-system events. The watcher polls every 250 ms, so a very large
    source costs one metadata walk per scan. Sources are capped at 20 000
    entries, as installed artifacts are.
- **Known limits:**
  - If the new generation's host fails to activate, the old host is already
    draining. The plugin's backend then waits for the next saved fix, or for
    `plugin.host.restart`. The failure appears as the reload's `message` and in
    `plugin.host.status`.
  - After the old host drains, its generation shows `retired` at once. Its row
    and artifact directory are cleaned up at the next generation list, reload,
    disable or daemon start.
- **Shared files:** none of the coordinator-owned files were edited. These
  files outside the plugin domain gained one line each:
  - `crates/ade-daemon/src/sessions/hooks.rs`: the hook dispatcher also
    refreshes after a background reload. rustfmt wrapped this line.
  - `apps/cli/src/index.ts`: the import, the usage fragment and the handler.
