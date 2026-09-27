# phase2-plugin-host

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-3
Worker: Phase 2 round D workflow, slice plugin-host
Requirements: F057 (backend extensions, advanced, not accepted); F060 (bounded host logs and explicit restart, partly advanced)

## Outcome

A plugin with a `backend` entry point now runs in a headless Node host,
`packages/plugin-host`. The host imports nothing from Electron (decision D05).
The daemon starts one host per activation generation, lazily, on the first
`plugin.command.invoke`. It talks to the host over JSON-RPC on stdio with four
methods: `activate`, `deactivate`, `invoke` and `health`. A supervisor restarts
a crashed host after 500 ms, 2 s and 5 s. After a fourth consecutive crash the
host stays errored until `plugin.host.restart` runs. Disabling the plugin runs
the plugin's `deactivate` hook with a bounded wait, kills the host's process
group and retires every generation issued so far.

Reliability rules:

- The core stays available while a host is down. `plugin.list`, the records
  and the settings keep working. An invocation fails with `not_applied` and says
  why: backoff with the time left, errored with the restart command, or not
  enabled.
- `plugin.command.invoke` moves its receipt to `dispatched` before it writes the
  request to the host.
  - If the host refuses before plugin code runs (stale generation, command not
    registered, not active) or never reads the request, the invocation settles
    `not_applied`.
  - If the handler throws, it settles with a `failed` outcome.
  - If the host crashes, times out after 60 s or breaks protocol while the call
    is open, the receipt becomes `unknown` and the reply is `outcome_unknown`.
    A replay returns the same `outcome_unknown` and never runs the command again.
- After a daemon restart, an `accepted` invocation receipt is settled
  `not_applied`, because the request was never sent. A `dispatched` one becomes
  `unknown`.
- Generation fencing works at three levels:
  - Every host carries a key, the generation plus its start attempt. Only the
    running attempt's exit counts as a crash. A late exit from an older
    generation, or from an attempt already stopped on purpose, changes nothing.
  - A late invocation cannot start a host for a disabled generation.
  - The host itself refuses requests for a generation it does not serve.
- No host call runs while the registry lock is held. A slow plugin blocks only
  its own slot, and only for activation, which is bounded at 15 s.
- The host redirects plugin console and stdout writes to stderr. The daemon
  keeps the last 200 stderr lines, each capped at 2 KiB, as the log tail. A
  frame over 4 MiB, or one that is not JSON, gets the host killed.
- Each host runs in its own process group. Kills go to the group and never
  signal a reaped PID: the waiter observes the exit with `waitid(WNOWAIT)`, sweeps
  the group, then reaps. A host exits when its stdin closes, so the hosts die
  when the daemon does.

Pure logic:

- `crates/ade-daemon/src/plugins/supervision.rs`: the backoff schedule,
  stable-run reset, attempt keys and exit fencing.
- `crates/ade-daemon/src/plugins/host.rs`: `classify`, which maps each response
  to one of four outcomes (result, refused, failed, unknown), and `adopt`, the
  generation fencing for each plugin's host slot.
- `crates/ade-daemon/src/plugins.rs`: `interrupted_invocation`.
- `packages/plugin-host/src/protocol.mjs`: the host state machine and message
  handling.

## Operation tiers

| Operation | Tier |
|---|---|
| `plugin.command.invoke` | effect command (receipt, daemon fingerprint, `dispatched` before send, `unknown` when unprovable) |
| `plugin.host.status` | query (never starts a host; probes a running host's health with a 2 s timeout) |
| `plugin.host.restart` | idempotent command (converges on a fresh running host for the live generation) |
| `plugin.enable` | idempotent command, unchanged on the wire; it now starts no host (lazy) |
| `plugin.disable` | idempotent command, unchanged on the wire; it now stops and retires the host |

The CLI adds `ade plugin invoke PLUGIN_ID COMMAND_ID --request-id ID [--args JSON]`
and `ade plugin host status|restart PLUGIN_ID` to `apps/cli/src/commands/plugins.ts`.

## Checks

- `pnpm check:static`: pass. It ran rustfmt, the contract check, the
  architecture check, the SDK build, typecheck (now including
  `@ade/plugin-host` through `checkJs`), Fallow, the JS build, the JS pure tests,
  Clippy and the legacy Rust tests.
- In-process tests added:
  - `packages/plugin-host/src/protocol.test.mjs`: 11 tests.
  - `crates/ade-daemon/src/plugins/supervision.rs`: 6 tests.
  - `crates/ade-daemon/src/plugins/host.rs`: 2 tests.
  - `crates/ade-daemon/src/plugins.rs`: 1 test.
  - `crates/ade-core/src/contract/plugins.rs`: its round-trip tests now cover
    the three new operations.
- A manual smoke run, not committed, drove a real `ade-daemon` and `ade-runtime`
  through the CLI with a fixture backend plugin. It confirmed each of these:
  - Invoking before enable is refused. After enable, the host state is `idle`
    and no process runs.
  - The first invocation starts the host, and settings reach `activate`.
  - A replay with the same ID returns the stored result. The same ID with other
    arguments returns `conflict`.
  - A throwing handler returns a `failed` outcome. An undeclared command is
    refused.
  - A host that exits mid-call gives `outcome_unknown`, and so does its replay.
    An invocation during backoff gives `not_applied` with the time left.
    `plugin.list` still answers, and the host restarts automatically after
    500 ms.
  - After four crashes the host is `errored` and invocations are refused.
    `plugin.host.restart` brings it back at attempt 5.
  - Disable runs the plugin's `deactivate` hook and leaves no host process.
    Re-enable runs at generation 2 in a fresh process.
  - No host survives a daemon exit.
  - After a restart, a `dispatched` receipt becomes `unknown` and an `accepted`
    one becomes `not_applied`. The next invocation starts a host lazily at
    generation 3.

Verified only statically:

- The 60 s invocation timeout and the kill it triggers.
- The oversized-frame and non-JSON-frame kills.
- The 15 s activation timeout.
- Killing a host's descendants through its process group.
- `ADE_PLUGIN_HOST` and the packaged resource path
  `Resources/packages/plugin-host/src/host.mjs`. `pnpm package:mac` was not run.
- The 32-call cap for each host.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 110 | 0 | 15 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/main/plugins/plugin-worker-supervision.integration.test.ts` (MIT): pattern. The 500/2000/5000 ms restart schedule, then an errored state. No code copied.
- Orca, `src/main/plugins/plugin-host-entry.ts` (MIT): pattern. The host exits on a fatal error or a lost parent channel. No code copied.
- OpenCode-v2, `packages/core/src/plugin.ts` (MIT): studied for activation-scoped cleanup. No code copied.
- `crates/ade-daemon/src/review.rs`: the process-group kill pattern this slice follows.
- `crates/ade-daemon/src/receipts.rs` and `plugins.rs`: the receipt admission this slice extends.

## Open

- **Needs E2E later (F057 acceptance):** run an extension in a headless host,
  crash it, and show core availability and the failed operations through the
  running app.
- **Architecture note:** backend hosts are supervised by the daemon, following
  the section 1 diagram (Daemon to backend plugin hosts). The task text said
  "runtime". Provider workers (the third entry point) stay runtime-owned and
  are not built here.
- **Not built:**
  - A host-to-core API, so plugin code cannot yet call records, settings or
    commands. The protocol has no host-to-daemon requests.
  - Services that run without an invocation. The host starts only on demand;
    after a crash it restarts on its own schedule.
  - Old-worker leases across an update (04-S11).
  - Hot reload (F060).
  - Dynamic registration of commands the manifest does not declare.
    Registration is limited to declared commands.
- **Isolation unit:** one process per enabled plugin with a backend. Grouping
  inactive plugins into shared hosts is left open, as architecture section 8
  allows.
- **Node availability:** the host runs `ADE_NODE_BIN` or `node` from `PATH`. The
  packaged app does not ship Node, so a missing Node fails the invocation
  explicitly with `not_applied`. D05 needs a decision on shipping Node LTS
  against using Electron as Node.
- **Environment:** the host inherits the daemon's environment. Installed code
  is trusted (spec decision 1), but a scrubbed environment may be wanted.
- **Shared files touched:**
  - the root `package.json` typecheck script (one added filter);
  - `scripts/package-macos.mjs` and `electron-builder.yml`, to stage the host
    script;
  - `pnpm-lock.yaml`, for the new workspace package.
