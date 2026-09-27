# e2e-plugins

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-7
Worker: E2E round 1 workflow, slice plugins
Requirements: F051, F057, F058 (register acceptance passes as headless E2E); F059, F139, F023, F060, 04-S11 (advanced, not accepted)

## Outcome

Headless E2E specs in `e2e/protocol/plugins/` now drive real `ade-daemon`,
`ade-runtime` and plugin host processes through the SDK and the CLI. They use
two fixture plugins in `e2e/protocol/fixtures/plugins/`: `backend` (commands,
settings and lifecycle hooks) and `provider` (a provider worker). They cover
install, lifecycle, state, the backend host, hooks, development-mode reload
and provider registration.

The specs exposed one product gap in this area: lifecycle hooks were never
delivered. The daemon still wired `NoHost` into the hook dispatcher, so every
delivery waited in `awaiting_host` forever. That is now fixed; see Product fixes.

The register acceptance of F051, F057 and F058 now passes as E2E. For F051,
status is visible through the SDK and the CLI. No UI exists yet, because
Electron E2E is paused.

## Acceptance criteria

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| F051 | Install a pinned local artifact | `lifecycle.spec.ts` › installs a local plugin… | pass |
| F051 | Install pinned package and Git artifacts, and refuse a wrong SHA-256 or commit | `lifecycle.spec.ts` › installs the same artifact pinned from a package archive and a Git commit | pass |
| F051 | Enable, disable and remove, with status visible (SDK and `ade plugin list/inspect`) | `lifecycle.spec.ts` › installs a local plugin… | pass |
| F051 | Duplicate install request: replay, and conflict on a changed payload | `lifecycle.spec.ts` › installs a local plugin… | pass |
| F051 | Reject incompatible manifests before activation: API version, manifest version, ID, missing entry, version pin | `lifecycle.spec.ts` › rejects incompatible manifests… | pass |
| F051 | Visible status in the UI | none (Electron E2E paused) | not covered |
| F057 | Run an extension in a headless Node host (no Electron) with its settings | `host.spec.ts` › runs backend commands in a headless host… | pass |
| F057 | Crash it: an invocation's outcome is `outcome_unknown` and its replay never re-runs it | `host.spec.ts` › a crashing host… | pass |
| F057 | Bounded backoff (500 ms, 2 s, 5 s), then errored until `plugin.host.restart` | `host.spec.ts` › a crashing host… | pass |
| F057 | Core availability while the host is down (list, records) | `host.spec.ts` › a crashing host… | pass |
| F057 | A host killed from outside counts as a crash; a killed daemon takes its hosts with it; restart re-activates at a new generation | `host.spec.ts` › a host killed from outside… | pass |
| F058 | A committed `workspace.created` delivered once, after commit, with a stable effect ID | `hooks.spec.ts` › delivers a committed workspace.created hook… | pass |
| F058 | A committed `turn.settled` from a real Conversation turn (Codex mock) | `hooks.spec.ts` › a settled Conversation turn… | pass |
| F058 | No subscription while disabled, so nothing is enqueued | `hooks.spec.ts` › delivers a committed workspace.created hook… | pass |
| F058 | A failed delivery is retried only on request, with the same effect ID; a duplicate retry returns its first answer; abandon | `hooks.spec.ts` › a failed hook is sent again only on an explicit retry… | pass |
| F058 | A host that crashes mid-delivery gives `unknown`; it is never resent automatically; a retry needs `acknowledge_unknown` | `hooks.spec.ts` › a hook whose host crashed mid-delivery… | pass |
| F058 | A delivery in flight when the daemon dies becomes `unknown` after restart and is never replayed | `hooks.spec.ts` › a delivery in flight when the daemon dies… | pass |
| F059 | Namespaced records with compare-and-set; two plugins with the same namespace and key do not collide | `lifecycle.spec.ts` › keeps namespaced records and settings apart… | pass |
| F059 | Declared, typed settings; credential references (no default, reference values only) | `lifecycle.spec.ts` › keeps namespaced records… | pass |
| F059 | Records and settings survive a daemon crash and an uninstall without purge; purge removes them; data-schema downgrade refused | `lifecycle.spec.ts` › keeps namespaced records… | pass |
| F059 | Managed records take part in backup; private-data backup exclusions documented | none (backup domain) | not covered |
| F139 / F060 | A dev-mode reload bumps the generation; the call running on the old host completes there; new work reaches the new generation; the old host drains, deactivates and retires | `dev-reload.spec.ts` › a reload bumps the generation… | pass |
| F139 / F060 | A broken reload reports `failed` with its reason and the current generation keeps serving; the fix activates the next; an edit made while the daemon was down reloads after restart; leave | `dev-reload.spec.ts` › a broken reload… | pass |
| F060 | Plugin console output reaches the bounded host log tail | `host.spec.ts` › runs backend commands… | pass |
| F139 / 04-S11 | A dev reload keeps a leased provider session on its old generation | `dev-reload.spec.ts` › a dev-mode reload keeps a leased provider session… | fixme |
| F139 | React UI reload, Electron main restart, component previews | none (Electron E2E paused) | not covered |
| F023 | A provider plugin registers a pinned `plugin:<id>` worker beside the bundled providers; disabling removes it; a newer version registers with its own pin across a daemon crash; the CLI shows it | `provider-plugins.spec.ts` › an enabled provider plugin registers… | pass |
| F023 | A plugin provider registers only in its own namespace; a provider-only manifest cannot contribute commands | `provider-plugins.spec.ts` › a provider plugin registers only… | pass |
| F023 | Run a turn on a provider plugin and read its history after disabling it | `provider-plugins.spec.ts` › a turn runs on a provider plugin… | fixme |
| F023 | A worker crash mid-turn ends the run without redispatching | `provider-plugins.spec.ts` › a provider worker that crashes mid-turn… | fixme |

## Product fixes

**Lifecycle hooks were never delivered (F058).**

- Cause: `Sessions` built its dispatcher with `Dispatcher::default()`. That
  used `NoHost`, so every delivery stayed in `awaiting_host`. The plugin host
  also had no method to receive a hook.
- Fix:
  - `packages/plugin-host/src/protocol.mjs`: the host has a `hook` method and
    gives plugins `context.hooks.on(event, handler)`.
    - A handler may be registered only for an event the manifest declares.
    - The handler receives `effectId`, `event` and `attempt`.
    - If no handler is registered, the call is refused with `-32005` before
      any plugin code runs.
  - `crates/ade-daemon/src/plugins/host.rs`:
    - `LaunchSpec` carries the manifest's hooks.
    - `-32005` counts as a refusal.
    - A new pure function, `hook_verdict`, maps a host reply to a
      `HookVerdict`:
      - a result is `delivered`;
      - a refusal is `not_started`;
      - a handler error is `failed`;
      - a lost answer is `unknown`.
  - `crates/ade-daemon/src/plugins.rs`:
    - `Plugins::hook_host()` implements `hooks::HookHost` over the backend
      hosts.
    - It starts the plugin's host lazily and sends `hook` with the generation
      fence.
    - On an unknown outcome it kills the host, and the supervisor restarts it.
  - `crates/ade-daemon/src/sessions.rs` uses that host whenever the registry
    opened. `NoHost` is left only for a registry that failed to open.
- Test: `plugins::host::tests::hook_verdicts_retry_only_what_never_started`.
- No wire change. `hook.delivery.list` now reports `host.available: true` while
  the registry is open.

## New fixtures

- `e2e/protocol/fixtures/plugins.ts`:
  - `stagePlugin` copies a fixture plugin into the test's temp root and can
    patch its manifest.
  - `installAndEnable` installs, enables and points `out_dir` at a readable
    directory.
  - `pluginLines` reads what the plugin recorded.
  - `releasePlugin` creates a release file for a held command or hook.
- `e2e/protocol/fixtures/plugins/backend/`:
  - Commands: echo, fail, crash and a held command.
  - Settings: `out_dir` and a `token` credential reference.
  - Hooks: `workspace.created` and `turn.settled`. Folder names containing
    `crash-hook`, `fail-hook` or `hold-hook` select the failure mode.
- `e2e/protocol/fixtures/plugins/provider/`: a version 1 provider worker that
  answers "Hello plugin". Only its registration runs today.
- `e2e/protocol/fixtures/index.ts` is unchanged. Specs import the plugin
  helpers from `../fixtures/plugins`.

## Operation tiers

No operation was added or changed.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/plugins`: 16
  passed and 3 fixme (skipped).
- The plugins and boot specs also ran together with `--repeat-each 3`: 69
  passed, 0 failed.
- `pnpm check:static`: pass. It ran rustfmt, the contract check, architecture,
  typecheck, Fallow, the builds, the JS pure tests, Clippy and the legacy Rust
  tests.
- In-process tests added: `crates/ade-daemon/src/plugins/host.rs`,
  `hook_verdicts_retry_only_what_never_started`.
- `pgrep` found no `ade-daemon`, `ade-runtime` or plugin host process from
  this worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 5 | 20 | 0 |

## References

- lux-ade `.scratch/ade-v1/evidence/phase2-plugin-*.md`, `phase2-provider-plugins.md`, `audit-fix-plugins.md` and `audit-minor-plugins-providers.md`: the "needs E2E later" lists these specs cover.
- lux-ade `docs/provider-worker-protocol.md`: the fixture provider worker follows it.
- None copied from reference repos.

## Open

- **F023 and 04-S11 gap (outside this slice's modules: conversations and
  agents).**
  - `conversation.create` validates `provider` against the static
    `ade_core::provider::descriptor` catalogue, which refuses `plugin:<id>`.
  - `sessions/agents.rs` launches every run with `Spec.worker: None`.
  - As a result, `Plugins::lease_provider` has no caller, so a generation can
    never be `leased`.
  - Three fixme specs name this gap and pass once it is closed:
    - `provider-plugins.spec.ts`: the turn and history spec, and the worker
      crash spec;
    - `dev-reload.spec.ts`: the leased provider session spec.
  - `AgentRunSpec` also lacks a `worker` field; this is a coordinator contract
    change.
- **F059:** managed records' backup participation and the documented
  private-data exclusions were not proven here. They belong to the backup
  domain's E2E.
- **Test finding, not a defect:** a dev reload makes the new generation
  `current` before `dev.last_reload` records `activated`, because the outcome
  is written after the new host starts. The spec polls for both.
- **Hook dispatch:** one slow hook handler holds the single dispatcher thread
  for up to 60 s (the invoke timeout), which delays every other plugin's
  deliveries. This is left as it is and noted for a later slice.
