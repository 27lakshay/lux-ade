# e2e-packaged

Status: returned
Type: slice evidence
Branch: claude/wf_58471be9-2ec-3
Worker: E2E round 5, packaging worker
Requirements: R020 (advanced, not accepted: its headless part passes; launching the packaged app window waits for the UI phase)

## Outcome

Headless E2E specs in `e2e/protocol/packaged/` run the installed macOS bundle
built by `pnpm package:mac`. They run its `ade`, `ade-control`, `ade-daemon`,
`ade-runtime`, Bun and Electron-as-Node from a scratch environment with
`PATH=/usr/bin:/bin`, a scratch `HOME` and no node, cargo, pnpm or repository
path. 9 specs pass, with none marked `test.fixme`. The specs skip, naming the
reason, when no bundle with `Resources/bin/ade-node` exists.

The specs exposed two packaging bugs, both fixed:

1. A daemon started by the bundled `ade-control` alone used the host's `node`
   and `bun` from `/opt/homebrew/bin`, not the bundle's. On a clean Mac, the
   Claude bridge and the Codex relay would not start. Only the bundled CLI and
   the desktop set `ADE_NODE_BIN` and `ADE_BUN_BIN`.
2. `ELECTRON_RUN_AS_NODE=1` reached every terminal, service and agent tool of a
   packaged profile. Any Electron app a user started from an ADE terminal
   would run as plain Node.

The fix has two parts:

- `pnpm package:mac` now writes `Resources/bin/ade-node`. This shell shim runs
  the bundle's Electron with `ELECTRON_RUN_AS_NODE=1` for that process alone.
- When packaged, `ade-control` removes `ELECTRON_RUN_AS_NODE` from the daemon's
  environment. It then sets `ADE_NODE_BIN` to `bin/ade-node` and `ADE_BUN_BIN`
  to `bin/bun`, whoever launched it.

## Acceptance criteria and specs

R020 "Launch packaged macOS artifact in a clean environment; find declared native/provider resources, handle incompatible live owners safely and exercise primary daily-use E2E flows":

| Criterion part | Spec | Result |
|---|---|---|
| Declared native and provider resources are in the bundle: the 5 executables, Bun, `ade-node`, the CLI and its SDK, the Claude, Codex, OMP and opencode provider code, and the plugin host. No test fixture or Python script ships. | `bundle.spec.ts`: the bundle carries every declared native and provider resource and no test fixture | pass |
| The bundle is relocatable: the `ade` launcher, the provider `.bin` shims, the CLI, the plugin host and `app.asar` never name the build checkout | `bundle.spec.ts`: bundled launchers and provider shims are relocatable and never name the build checkout | pass |
| Version discovery: `Info.plist` and the bundled CLI carry the desktop version. `ade-control version` reports its protocols and finds its sibling daemon and runtime. Bun 1.3.14 and `ade-node` run from the minimal PATH. The CLI runs through a symlink placed elsewhere. | `bundle.spec.ts`: the bundle reports its versions and protocols with no development tooling on PATH | pass |
| Clean-environment cold start through the bundled `ade-control`: the daemon and runtime are the bundle's executables, and the daemon is detached with ppid 1. `build_id` is the SHA-256 of the bundled daemon. The protocols match `ade-control version`. The data stays under the scratch profiles home. A second start attaches to the running daemon. The SDK and the bundled CLI both reach it. | `cold-start.spec.ts`: bundled ade-control cold-starts a profile daemon and runtime from the bundle | pass |
| Incompatible live owners are handled safely: a future-protocol owner at the profile's endpoint is asked, left listening and never replaced. Both `ade-control` and the CLI explain the refusal. The registry is unchanged. No daemon was launched. | `cold-start.spec.ts`: bundled ade-control and CLI leave an incompatible live owner running and explain recovery | pass |
| Primary daily-use flow through the installed CLI: cold start, open a workspace, and run one Codex and one Claude turn. Codex runs behind the bundle's `shared-server.mjs` under the bundle's Bun. Claude runs through the bundle's `bridge.mjs` under the bundle's Electron-as-Node. | `cli-turn.spec.ts`: the installed CLI cold-starts a profile and runs Codex and Claude turns through bundled Bun and Node | pass |
| The same turns on a daemon cold-started by `ade-control` alone, with no CLI | `cli-turn.spec.ts`: a daemon cold-started by bundled ade-control alone runs Claude and Codex turns under the bundle's Node and Bun | pass (failed before the fix) |
| Daily-use terminal: a packaged profile's shell has the scratch HOME and no `ELECTRON_RUN_AS_NODE` | `cli-turn.spec.ts`: a terminal on the installed profile runs a login shell without the bundle's Node switch | pass (failed before the fix) |
| A bundle moved to a folder with spaces runs its own daemon, runtime, Bun, Node and relay from the new path | `cli-turn.spec.ts`: a bundle moved to a folder with spaces runs its own executables and resources | pass |
| Launch the packaged Electron app, and drive daily-use flows in its window | none | not covered: waits for the UI phase (Electron E2E is paused). The legacy `e2e/packaged/macos.spec.ts` still holds those flows. |

Provider fixtures stand in only for what a user installs or signs in to: the
Codex CLI, and the Claude SDK's model calls. The fixtures are copied out of
the repository into the test's scratch root. `ADE_CODEX_BIN` is a Bun
WebSocket relay to `codex_mock.py`, run with `/usr/bin/python3`.
`ADE_CLAUDE_BRIDGE` is a runner that imports the bundle's own `bridge.mjs`
with the fake SDK. The Node and Bun that run them, and the relay and bridge
code, are the ones the product chose from the bundle. Each fixture records its
launcher, and the specs assert on that record.

## Machine safety

A release daemon refuses the test-only file secret store, so a packaged
daemon's secret store is the Keychain backend. The daemon reaches the Keychain
only to resolve or store a credential reference: services, plugins, remote
pairing and provider accounts. The packaged specs create none of these, so no
packaged process calls the Security framework. `packagedEnvironment` refuses
`ADE_KEYCHAIN` and `ADE_SECRET_*`.

`pnpm package:mac` ran once, with `CSC_IDENTITY_AUTO_DISCOVERY=false`.
`electron-builder.yml` has `identity: null`, so electron-builder logged
"skipped macOS code signing". It creates a keychain only when `CSC_LINK` is set,
and `CSC_LINK` was not set.

The two fixes were applied to that bundle without a second package run:

- the rebuilt release `ade-control` was copied into `Contents/MacOS`;
- `Resources/bin/ade-node` was written from the script's own template.

A later `pnpm package:mac` produces the same files. No hdiutil or other system
disk service was used. After the runs, `pgrep` found no `ade-daemon`,
`ade-runtime`, `security` or `Lux ADE` process from this worktree.

## Operation tiers

None added or changed.

## Checks

- `pnpm package:mac`: pass (once)
- `pnpm build:backend && pnpm build`: pass
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only packaged profiles`: 21 passed. The `profiles` specs were rerun because `managed-profiles.ts` changed.
- `pnpm check:static`: pass
- In-process tests added: none

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 60 | 10 | 20 | 5 |

## References

- lux-ade `e2e/packaged/macos.spec.ts` (legacy): studied for bundle layout and the Codex relay fixture, which was adapted into `e2e/protocol/fixtures/packaged.ts`

## Open

- R020 stays advanced, not accepted, until the UI phase launches the packaged app window in a clean environment.
- Outside this area: the Claude bridge still runs with `ELECTRON_RUN_AS_NODE=1`, so the Claude SDK's child processes and the agent tools they run inherit it. This does not happen for terminals, services, Codex or OMP. The bridge could delete the variable once it has started, if the SDK does not relaunch `process.execPath`. The providers area should decide.
- The legacy `e2e/packaged/macos.spec.ts` Claude wrapper now uses `bin/ade-node`, because the daemon no longer passes `ELECTRON_RUN_AS_NODE` on. That spec launches Electron, so it was not run in this round.
- `fixtures/managed-profiles.ts` gained a `Launcher` parameter. The default, `sourceLauncher`, keeps every existing spec unchanged.
