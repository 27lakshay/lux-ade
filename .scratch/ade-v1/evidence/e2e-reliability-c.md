# e2e-reliability-c

Status: returned
Type: slice evidence
Branch: claude/wf_317b0f50-41b-4, finished on claude/wf_c51346dc-a4d-2
Worker: ADE parallel build, E2E round 3, slice reliability-c; review blocker fixed in round 4
Requirements: R007, R013, R015, R018 (full register acceptance passes); R016, R019 (partial)

## Outcome

Headless specs in `e2e/protocol/reliability-c/` prove six shared reliability
requirements against real daemons and runtimes through the SDK, the CLI and the
raw protocol. 12 tests pass and none is `test.fixme`. The specs exposed five
product bugs in this area, and all five are fixed:

- **R007.** `resources.registry.accept` replaced a corrupted or missing
  registry with an empty one while another profile's daemon was still live and
  held claims in the old file. Those claims were forgotten.
- **R013.** `plugin.disable` killed a backend host with SIGKILL while a
  command was still running on it. The command's outcome became unknown.
- **R013.** `plugin.install` raised a plugin's data schema while leased
  provider sessions still ran older code against the same records. A
  development reload already refused this.
- **R016.** The browser relay passed on a `browser.inspect` reply whose tab
  record named another tab (a popup), and `browser.list` or `browser.inspect`
  replies whose tab records named another browser profile.
- **R019.** Under load, `catalog.get` and `session.subscribe` failed with
  "Catalog changed during workspace identity inspection; retry". Any revision,
  such as a turn event, invalidated the filesystem probe, so a busy profile
  could not read its catalogue.

R016 and R019 are partial. The R016 viewer itself (frames, popups and the
renderer bridge in Electron) is for the UI phase. The R019 fixture has no
browser tabs and no large searchable history.

## Acceptance criteria and specs

### R007: coordinate physical resources across profiles

| Criterion part | Spec | Result |
|---|---|---|
| Race claims across profiles | `resources/host-resources.spec.ts` › a launch racing a removal…; two profiles reserving the same unborn path… (round 1) | pass |
| Path aliases | `resources/host-resources.spec.ts` › a profile cannot remove a checkout another profile works in, by its path or an alias (round 1) | pass |
| Path replacement: a checkout moved by Git keeps its claim; a new checkout at the old path does not inherit it and can be removed; the moved one stays protected | `reliability-c/resources.spec.ts` › a checkout moved away keeps its claim… | pass |
| Corrupt a registry with a live owner: new lifecycle work fails closed (`host_resources_unavailable`, `recover_host_resources`); accept is refused while the owner is live and the file is left byte for byte; after the owner stops, accept moves it aside | `reliability-c/resources.spec.ts` › a registry corrupted under a live owner… | pass after fix 1 |
| Migrate a registry to a newer format with a live owner: blocked, accept refused, every claim still in the file; back at a supported format, the live owner's claim still refuses removal | `reliability-c/resources.spec.ts` › a registry migrated to a newer format… | pass |
| Missing registry with a live owner; an unreadable one accepted after the owner stops | `resources/host-resources.spec.ts` › a lost or unreadable registry… (round 1) | pass |
| Port and device claims across profiles | `services2/claims.spec.ts`, `devices/claims.spec.ts` (other areas) | pass |

### R013: continue active work while plugins update

| Criterion part | Spec | Result |
|---|---|---|
| Update code with a leased old worker: a provider turn held on version 1 keeps running through disable, install of version 2 and enable, then finishes on version 1; the old Conversation keeps using version 1; new Conversations use version 2 | `reliability-c/plugin-update.spec.ts` › a provider Conversation mid-turn… | pass |
| Update code with a busy backend host: a held command finishes on the version 1 host while new commands reach version 2 | `reliability-c/plugin-update.spec.ts` › a backend command running on the old host… | pass after fix 2 |
| An enabled plugin's artifact is never replaced: install is refused until disable | both specs | pass |
| Data schema: a raise is refused while provider sessions lease the plugin (drain required); without leases it rises; version 1 records stay readable; a rollback of the code is refused | both specs | pass after fix 3 |
| Keep compatible artifacts: version 1 stays `leased` after its worker exits, and the old Conversation resumes on version 1 after a daemon crash | provider spec | pass |
| Late old cleanup cannot remove new registrations: the old worker exits (provider) or the old host deactivates (backend) after version 2 is current; `plugin:<id>` stays in the catalogue, version 2 commands stay registered and answer from the same host | both specs | pass |
| Dev-mode reload during work; broken reload | `plugins/dev-reload.spec.ts` (round 2) | pass |

### R015: control retention without losing referenced work

| Criterion part | Spec | Result |
|---|---|---|
| Concurrently with a backup: `retention.apply` and `attachment.reclaim.apply` run while `ade-control backup create` copies the live profile; the backup restores the referenced upload and its draft | `reliability-c/retention.spec.ts` | pass |
| Concurrently with blob finalization: an upload referenced by a draft after its reclaim preview is refused and kept; five uploads made during apply are kept; a candidate set that changed after the preview is refused | same | pass |
| Concurrently with active execution: a held agent turn, a terminal shell and a service with a 10-day-old log keep running, and their logs stay | same | pass |
| Preserve live, in-flight and referenced artifacts; only the previewed unreferenced items go | same, and `ops/retention.spec.ts` (round 2) | pass |
| Preserve unresolved resource claims: a service quarantined after a runtime crash keeps its 30-day-old log | `ops/diagnostics.spec.ts` › a runtime crash leaves unknown execution… (round 2) | pass |

### R016: keep preview content separate from application authority (daemon and protocol level)

| Criterion part | Spec | Result |
|---|---|---|
| Adversarial files: HTML, XHTML, SVG, XML, fake PNG and binary are `unsupported` with no content; text that looks like protocol frames is one string field; images are validated; previews stop at 256 KiB | `reliability-c/preview.spec.ts` › file previews are inert… | pass |
| No cross-profile data: links into another profile's HOME and database, `..` and absolute paths are refused; listings show links as links; a FIFO fails at once; the other profile's daemon does not serve this profile's workspace | same | pass |
| Adversarial page and popup content through the browser relay: page text is inert; a reply for a popup or another tab, another profile or owner, or another browser profile is refused; a reply outside the contract is refused; only the request's own fields reach the owner | `reliability-c/preview.spec.ts` › browser page content… | pass after fix 4 |
| Another profile cannot answer for or take over this profile's browser owner; non-private or linked owner sockets are refused | same | pass |
| Storage profile naming: a fixed-socket owner registered as `fixed-<hash>` reports tabs under `fixed` and is relayed; the same replies naming `fixed-<hash>`, `fixed-other` or another socket's profile are refused | `reliability-c/preview.spec.ts` › a fixed-socket owner reports tabs under its fixed storage profile… | pass after review fix |
| Storage profile naming: a managed profile's owner reports tabs under the profile ID itself and is relayed; `fixed` is refused | `reliability-c/preview.spec.ts` › a managed profile owner reports tabs under the profile ID itself | pass after review fix |
| Frames, popups and the renderer bridge in the Electron viewer | none: Electron E2E is paused until the UI phase | not covered |

### R018: understand failures without exposing secrets

| Criterion part | Spec | Result |
|---|---|---|
| Real failures carrying credentials (a clone URL with a password, a provider that prints keys to stderr and dies, a send with a token to an unknown Conversation, an oversized request with a key) give typed, readable replies with no planted value | `reliability-c/secrets.spec.ts` | pass |
| Correlation: each failed request's `diagnostic_id` appears as `rpc_failed` in the export; provider stderr is counted by bytes, never kept | same | pass |
| The daemon's and runtime's own log files (`daemon.log`, `runtime.log`, rotated JSON logs, daemon stderr) hold no planted credential or transcript, before and after a daemon crash | same | pass |
| Bounded export; planted credentials in logs, environment, service secrets and account files redacted; transcripts excluded by default | `ops/diagnostics.spec.ts` (round 2) | pass |

### R019: use many active resources responsively

| Criterion part | Spec | Result |
|---|---|---|
| 10 agents, 20 terminals, 3 services, a 5000-line diff, a slow feed subscriber; sustained and idle phases | `reliability-c/load.spec.ts` | pass |
| Record p95 admission and echo, process-tree memory and queues | same (results below) | pass |
| Admission p95 under the provisional 250 ms target in both phases | same | pass after fix 5 |
| 5 browser tabs | none: needs Electron | not covered |
| Large searchable history | none | not covered |

Load results, one run on the audit host (Apple M4, 10 logical CPUs, 24 GiB),
with nine other E2E suites running at the same time (load average about 10 to
12):

| Measure | Sustained | Idle | Provisional target |
|---|---|---|---|
| Command admission p95 (`draft.save`, `agent.send`, `catalog.get`; 150 and 90 samples) | 98.2 ms | 57.0 ms | 250 ms |
| `agent.send` admission p95 | 113.7 ms | 54.8 ms | 250 ms |
| Terminal echo p95 (30 samples) | 34.7 ms | 0.5 ms | 50 ms (recorded, not asserted) |
| Large diff read (`review.diff`, 5000 lines) | 440 ms | | none |
| Process-tree memory (`phys_footprint`, 36 distinct processes) | 285 MiB | 286 MiB | no budget yet |
| Queues | `runtime.agent_runs` 10 of 16; `feed.subscribers` 2; outbox and prompt queue 0; `terminal.scrollback` 2.7 MB (no capacity reported) | same | bounded where a capacity exists |
| Slow consumers | the stalled feed subscriber was evicted (`feed.subscribers_evicted` 1); 19 streaming terminal attachments fell 64 frames behind, were closed and reattached from a snapshot | | |

Latency is the client-observed wall time of each SDK call, including its
connection and `hello`. The fixture provider answers at once, so provider
latency is excluded. These are one run's numbers, not a supported-machine claim.

## Product fixes

1. `crates/ade-daemon/src/host_resources.rs`: new pure `may_accept`. Accepting
   a missing or unreadable registry starts an empty one, so it is refused while
   another daemon incarnation still holds its liveness lock. `live_others`
   reads the owners directory. A newer registry is still never replaced;
   retrying an open or adopting a replacement is still allowed. Pure test:
   `recovery_never_starts_an_empty_registry_while_another_daemon_is_live`.
2. `crates/ade-daemon/src/plugins/host.rs` `Hosts::stop`: a host with open
   calls is drained like a superseded generation (bounded grace, then
   `deactivate` and kill). An idle host stops at once, as before, so an
   immediate uninstall is not refused as draining.
3. `crates/ade-daemon/src/plugins.rs` install: reuses the pure
   `dev::reload_schema` rule. A data-schema raise while provider sessions lease
   the plugin is refused with `conflict`. That rule already has pure tests.
4. `crates/ade-daemon/src/bin/daemon/server.rs`: new pure
   `browser_records_match`. An inspect reply must name the requested tab in
   `tab_id` and `tab.id`. Every tab record in an inspect or list reply, and a
   list's top-level `profileId`, must name the owner's browser storage
   profile. Pure test:
   `browser_replies_describe_only_the_requested_profile_and_tab`.

   Review fix (round 4). The round 3 version compared `profileId` with the
   daemon's ADE profile ID. The real Electron owner fills `profileId` with its
   browser storage profile, and in fixed-socket mode that is `fixed` while
   the daemon profile is `fixed-<hash>` (`apps/desktop/src/main/index.ts`), so
   every real fixed-socket `browser.list` and `browser.inspect` would have been
   refused. The daemon now derives a `BrowserIdentity` at start: a managed
   profile (`ADE_RUNTIME_HOME` set) has storage profile equal to its profile
   ID; a fixed-socket daemon has profile ID `fixed-<first 32 hex of
   sha256(absolute socket)>` and storage profile `fixed`. The relay matches on
   the storage profile (`Host::browser_storage_profile`). The owner identity
   check on the reply's `profile_id` is unchanged. Pure test:
   `browser_identity_names_the_owner_storage_profile`, which also pins the
   socket hash against a value computed outside Rust. The scripted owner in
   `e2e/protocol/fixtures/browser-owner.ts` now reports storage profiles as
   Electron does (`ownerStorageProfile`) and can register as a managed
   profile ID.
5. `crates/ade-daemon/src/sessions/workspaces.rs` `with_live_catalog`: only a
   change to the workspaces or their binding claims invalidates the probe.
   Conversations and windows are read again under the final lock, so the
   catalogue matches the revision it is given. `session.subscribe` sends its
   catalog frame and inserts the subscriber under that same lock.
   `CatalogBindingClaim` derives `PartialEq`. This is an equality check, not a
   new decision, so no pure test was added. The legacy Electron spec
   `workspace-registration.spec.ts` (a slow probe does not hold the lock) still
   describes this behaviour; it was not run because Electron E2E is paused.

## New generic fixture

- `e2e/protocol/fixtures/load.ts`: `startWorkload(profile, path, { agents,
  terminals, services })` builds the load workload. `timed`, `summarize` and
  `terminalEcho` measure latency. `ADE_E2E_LOAD_RESULTS=<file>` makes the load
  spec write its measurements to that file.

## Operation tiers

No operation was added and no tier changed. `plugin.install` and
`resources.registry.accept` gained refusals. The `browser.list` and
`browser.inspect` relays gained identity checks. The wire contract is unchanged.

## Checks

Round 4 (review fix), on `claude/wf_c51346dc-a4d-2`:

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only reliability-c`: 12 passed.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only context` (the other users of
  the browser owner fixture): 27 passed, 1 skipped.
- `pnpm check:static`: pass.
- Machine safety: no spec in this area calls the Security framework, the
  `security` tool or `hdiutil`. After the runs, `pgrep` found no `ade-daemon`,
  `ade-runtime` or `security` process from this worktree.

Round 3:

- `pnpm check:static`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/reliability-c`:
  10 passed.
- Regression suites for the changed code: `boot`, `resources`, `plugins`,
  `adapters`, `ops`, `context`, `errors` and `worktrees` (115 passed, 2 skipped
  as pre-existing fixmes). All other protocol suites: 240 passed, 13 skipped,
  1 failed once. The failure was `remote/transport.spec.ts` › a remote daemon
  crash is reported unknown…: the request after the SIGKILL got `protocol`
  instead of `unavailable`. It passed 3 of 3 on a rerun and touches no code
  this slice changed.
- In-process tests added: `host_resources::tests::recovery_never_starts_an_empty_registry_while_another_daemon_is_live`
  and `server::error_envelope_tests::browser_replies_describe_only_the_requested_profile_and_tab`.
- No `ade-daemon` or `ade-runtime` from this worktree was left running (`pgrep`).

## Bugs outside this area (not fixed)

- `worktree.adopt` of a checkout that Git moved (`git worktree move`) after
  the same profile adopted it fails with the raw "File exists (os error 17)".
  This is the adoption-marker issue the resources worker reported in round 1.
  The replacement spec adopts both checkouts only after the move.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 120 | 10 | 30 | 0 |
| Round 4 review fix: 25 | 5 | 15 | 5 |

## References

- `e2e/protocol/README.md` and `e2e/protocol/fixtures/*` (in-repo), pattern.
- `.scratch/ade-v1/evidence/e2e-resources.md`, `e2e-ops.md`, `e2e-plugins.md`,
  `phase2-host-resources.md`, `phase2-retention.md`, `phase2-diagnostics.md`
  and `phase2-plugin-dev-reload.md` (in-repo): the open lists these specs cover.
- `docs/proposed-architecture.md` section 12 (in-repo): fault scenarios 1, 6
  and the provisional load targets.

## Open

- R016: the Electron viewer (frames, popups, the renderer bridge) needs UI-phase E2E.
- R019: 5 browser tabs and a large searchable history are not in the headless
  fixture. There is no memory budget yet (decision D16). `terminal.scrollback`
  reports no capacity.
- Provider leases are released only by an admitted uninstall
  (`Plugins::release_provider` has no caller). After fix 3, a data-schema raise
  for a provider plugin waits until every Conversation that ever used the old
  version is gone or the plugin is uninstalled. The coordinator may want a
  decision on when an idle Conversation's lease ends.
- `daemon.log` and `runtime.log` are not bounded; retention reports them
  under `observed_logs` only.
