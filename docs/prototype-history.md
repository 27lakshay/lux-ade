# Historical prototype notes

These notes describe earlier prototype milestones. For current setup, use the repository README and CONTRIBUTING.md. Paths and architecture below may describe superseded versions.

# ADE native prototype

A working macOS ARM64 feasibility build, with separate Rust client and daemon.
Codex and Claude Code Conversations, workspace identities and window records persist in SQLite.
The application daemon owns durable Conversation state and orchestration. A separate
runtime supervisor owns provider processes, shells and terminal parser state.

## Workspace UI foundation

The GPUI client now uses an ADE presentation layer in `src/ui.rs`: warm graphite
surfaces, shared spacing and typography, restrained brass accents, status colors,
small controls and embedded Lucide icons. GPUI Kit supplies control behavior;
ADE owns presentation and workspace composition. Changes, Worktrees and Runtime
use the same color vocabulary. No UI dependency was added.

The main window gives the Conversation the center column, with workspace and
Conversation navigation on the left, a native terminal below, and an embedded
browser on the right. The composer accepts multiple lines; Send submits them
unchanged. Messages render Markdown headings, lists and code blocks. Agent setup
expands to reveal provider, model and permission settings. The browser has an
app-owned start page in `assets/browser-start.html` and explicit URL validation.

The visual references were T3 Code's Conversation/composer hierarchy, Orca's
workspace navigation, Ghostex's browser pane, OpenCode v2's restrained type and
spacing tokens, and Herdr's separation of workspace/state metadata. Reference
repositories were read without modification.

Drag the sidebar/browser dividers or the divider above the terminal to resize
the workspace. Footer controls show or hide each optional pane. Hiding a native
surface keeps its shell or page alive, and pane preferences persist separately
for each window. Saved windows from earlier builds receive the default layout.
Minimum sizes keep the Conversation and pane controls usable. Commands, keyboard
resizing and terminal/browser tabs are implemented. A full accessibility audit
and broader IME/international-keyboard coverage remain.
The native terminal retains its existing color palette.

### Commands, focus and tabs

`src/commands.rs` is the shared command registry for the palette, native menus,
workspace buttons and shortcuts. Search commands with **Cmd+Shift+P**; use the
arrow keys and Enter, or click a result. **Cmd+,** opens Keyboard shortcuts.
Save validates conflicts and reserved editing keys before applying bindings to
all windows. Blank values disable a binding; Restore defaults followed by Save
restores the defaults. Bindings persist in
`~/Library/Application Support/ADE/keybindings.json`; `ADE_KEYBINDINGS` overrides
that path for isolated tests. Shortcuts currently support Cmd plus optional
Shift/Control/Option and one ASCII character, rather than multistroke sequences.

| Action | Default shortcut |
| --- | --- |
| Focus sidebar / Conversation / terminal / browser / composer | Cmd+1 / 2 / 3 / 4 / 5 |
| Focus previous / next pane | Cmd+Option+[ / ] |
| Toggle sidebar / terminal / browser | Cmd+Shift+1 / 3 / 4 |
| New terminal / browser tab | Cmd+Option+T / B |
| Previous / next tab in the focused pane | Cmd+Shift+[ / ] |
| Move selected tab left / right | Cmd+Control+[ / ] |
| Close / reopen a tab | Cmd+Shift+W / Cmd+Shift+T |

The palette and View menu expose pane resize and reset commands; these can be
assigned shortcuts. The last commanded pane focus, pane dimensions, tab order,
active tabs and recently closed tab metadata persist per window. Native terminal
control keys and ordinary text editing pass through. The command palette uses a
native child window so WebKit and Ghostty cannot cover it.

Each terminal tab has a durable identity owned by its workspace and a separate
shell in the runtime supervisor. Closing its view does **not** stop the shell.
Reopen reconnects to that shell; use `exit` in the shell to stop it. Restart exited
terminal starts it again explicitly. A workspace can allocate 32 additional
shell identities, with a process-wide limit of 64 live terminal entries.

Browser tabs retain their native WebViews while switching, hiding and reopening
recently closed tabs. Active pages provide tab titles and navigation URLs. After
a client restart, pages load from saved URLs; page form state and navigation
history are not serialized. The cache retains up to 16 closed browser tabs.
Tab ordering uses commands or shortcuts; drag-to-reorder and browser profile
management remain future work.

The implementation references OpenCode v2's central command catalogue, T3 Code's
focus-aware shortcut routing, Paseo's shortcut override semantics, Herdr's
active-tab visibility, Orca's explicit tab close lifecycle, and Ghostex's
separation of session identity from pane placement. These are adapted to native
GPUI/AppKit and ADE's existing daemon/supervisor split; no UI dependency was added.

Validation for commands/tabs: 44 Rust tests, the durable session integration,
recovery integration and a new three-shell tab integration passed. Native checks
covered conflict rejection, live shortcut remapping, keyboard pane resizing,
terminal view reopen, browser draft retention, tab order, palette focus return,
and restoration of tabs and commanded focus after client restart. Both original
shell PIDs survived the native client restart. A one-window, 50-message performance
smoke check preserved exact stream content through reconnect and daemon recovery:
client idle CPU was 0.96% of one core, simultaneous output used 27.03%, and client
RSS ranged from 135 to 268 MiB across phases. This is a short smoke check, not a
long-duration or many-tab performance baseline. Raw data is under
`../../work/benchmarks/commands-tabs`.



The pane-layout change passed 39 Rust tests and the session integration suite,
including layout persistence and rejection of invalid pane sizes. Native checks
covered all three dividers, hide/show, independent windows, restart restoration
and the 1000×700 minimum window. Hiding the terminal preserved its shell PID.
The runtime build was then upgraded under the standing development authorization.

Validation: 38 Rust tests and the runtime recovery integration passed. Native UI
checks covered the 1220×800 empty state and a populated 1000×700 window, Markdown,
multiline submission through a deterministic provider, Agent setup and approval
resolution. A one-window benchmark with 50 historical messages preserved exact
stream content through client reconnect and daemon recovery. Client CPU was
0.63% of one core idle and 24.32% during simultaneous Agent/terminal output;
client RSS ranged from 134 to 252 MiB across phases. This short run is a smoke
check, not a new multi-window performance baseline or a memory plateau claim.

## Run

From this directory:

```sh
bash scripts/run.sh --release
```

Build only:

```sh
bash scripts/run.sh --release --build-only
```

The script uses this task's isolated Rust toolchain under `../../work/toolchains`,
builds into `../../work/target`, and refreshes `lux-ade.app`.
Use the script to launch: the app bundle is a local development bundle, not a
standalone distributable. It depends on the task-local resources and daemon.
No shell profile was changed. Building the aligned native renderer downloaded
and activated Apple’s Metal Toolchain component; Xcode selection was unchanged.

The first launch opens one window. Later launches restore saved windows (up to ten),
their selected workspace/Conversation, geometry and explicitly navigated browser URL.
New window creates another independent view. `--windows N` and `--ui-smoke` use
unsaved test windows, so benchmarks do not overwrite normal layouts.

Open folder adopts an existing directory or Git Worktree. It does not create,
move or delete Worktrees. Choose Codex or Claude, model and permission mode before
creating a Conversation. Those choices are stored with the Conversation; an existing
Conversation never changes provider. Codex uses the installed `app-server` with
`on-request` approvals and workspace-write or read-only sandboxing. Claude uses the
pinned official Agent SDK in a Node sidecar and the installed Claude Code executable.
Authenticate with the provider's own CLI first. Claude user/project/local settings
are separate opt-ins; none are loaded by default. ADE does not edit account settings.
Command/tool approvals, questions, cancellation and provider-history resume are
supported. Unsupported interactions fail explicitly. Claude cancellation closes the
connection if its interrupt receipt cannot rule out queued work; Resume then restores
history. It does not silently leave queued work running after Stop.

Closing the client leaves Agents and shells running. Planned application-daemon
replacement and unplanned application crashes preserve Codex/Claude process IDs,
Agent run IDs, active tools, pending questions and shell processes. The supervisor
authenticates its owner through a private Unix socket. An expiring handoff ticket
allows planned replacement; socket EOF permits recovery after an owner crash.
The replacement restores Agent and terminal worktree leases before accepting
commands. Git/lifecycle operations still block a planned replacement.

The application commits each provider event's sequence number with its Conversation,
messages and requests in one SQLite transaction. The supervisor retains events until
that commit is acknowledged. Reconnection replays uncommitted events, keeping pending
request IDs stable. It never resends a prompt from a durable intent alone. Command
receipts are reserved under the same lock as ownership admission, so a replacement
cannot mistake an accepted command for an undelivered one. Duplicate command keys
return the original result; conflicting content is refused. An aborted handoff retries
a fenced command only after the original owner control socket confirms ownership.

Event replay is bounded to 32 MiB per Agent, with 17 MiB frames and at most 128 events
per response. Command receipts are bounded to 4096 commands and 32 MiB per run.
Exhaustion fails explicitly; it never silently discards unacknowledged events or
replays uncertain side effects. Short event connection failures retry without stopping
the provider. Confirmed supervisor loss ends the active connection and gives a recovery
error. Provider-history Resume remains explicit when no live runtime can be recovered.

**The supervisor itself cannot yet be upgraded while preserving its processes.**
This build uses `ade-runtime-v3` for multiple shell identities per workspace.
Explicit `replace-supervisor --stop-active` supports upgrading v2 through its
fenced shutdown API; ordinary start/restart refuse incompatible supervisors.
The older v1 supervisor must be stopped through its owner first. OS restart and supervisor loss
are outside the live-handoff guarantee; retained snapshots do not preserve processes.

Use **Restart exited terminal** after a shell exits. This explicitly starts a new terminal run;
it refuses to replace a live shell. Application-daemon restart no longer creates a
new shell as a side effect.

The launcher uses a stable binding at `../../work/runtime/stable/runtime.json` and a
short private Unix socket path derived from that location. `ADE_RUNTIME_HOME` selects
another installation/profile; `ADE_SOCKET` overrides its application socket.
`ADE_DATA_DIR` selects a directory on first binding. A binding points to the original
canonical data directory: it does not copy SQLite databases or duplicate worktree
ownership records and locks. One unambiguous legacy store can be adopted automatically;
multiple stores require an explicit choice. An active legacy writer blocks adoption.
The old v6 process cannot hand off its already-owned PTYs, so stop it through its
owner only when those shells are no longer needed, then run:

```sh
python3 scripts/runtime.py adopt --data-dir ../../work/runtime/ade-v6-data
bash scripts/run.sh --release
python3 scripts/runtime.py status
python3 scripts/runtime.py restart
```

The controller never kills an incompatible or unresponsive daemon. Restart requires
an acknowledgement from the expected boot ID and release of the original writer
lock. A new client can attach to a compatible running daemon even when executable
hashes differ. The launcher reports the pending daemon update; applying it requires
the explicit restart command. SQLite schema v1/v2 migrates transactionally to v3 in place;
older binaries reject v3, and this build refuses unknown future versions. Saved
Conversations and window layouts stay in the same database.

For isolated direct tests, `ADE_DATA_DIR` defaults to the socket path with a `.data`
extension. `ADE_ROOT`, `ADE_CODEX_BIN`, `ADE_NODE_BIN`, `ADE_CLAUDE_BIN` and
`ADE_RUNTIME_SOCKET` override their corresponding resources. The runtime verifies
its canonical data-directory identity as well as its protocol version. Logs live in
`stable/daemon.log` and `<data directory>/runtime.log`. With explicit user approval,
the local v6 client and daemon were stopped and their data directory adopted in
place. Its one saved window was retained; it contained no Conversations. Other
older daemons were left running.

Focus terminal targets the native Ghostty surface. Typing transfers resize ownership;
opening another viewer does not steal it. The embedded WKWebView is independent
per window. Open overlay creates a GPUI child panel above the native surfaces.

## Runtime and recovery controls

The **Runtime** button opens a native recovery window. The workspace footer shows
connection, recovery and local-update status. Build checks run in a background
worker every 30 seconds and on demand; unknown identities remain unknown. The
checks compare running daemon/supervisor hashes with local binaries, not a release
server. No downloads or account configuration are involved.

- **Check builds** refreshes build and activity details.
- **Retry connection / start daemon** starts a missing daemon or reconnects to a
  compatible one. View subscriptions also retry automatically.
- **Reload client** replaces the client process and restores saved windows. Shells
  and Agents remain with the supervisor; unsent drafts are lost.
- **Restart daemon** uses the boot-fenced handoff and preserves running shells and
  Agents. Active Git/worktree operations can refuse the restart.
- **Replace supervisor** requires a separate confirmation. It ends live shells and
  Agents, retains saved data, waits for ownership locks, then starts the new build.
  Failure is displayed with a retry path; replacement never falls back to a kill.

When the daemon is unavailable at launch, ADE opens the recovery window instead
of exiting. Once a catalogue arrives, workspace windows open. Direct app launches
resolve the stable endpoint through the same controller as scripted launches.
The keyboard adapter receives the resolved socket explicitly and is recreated
when the daemon boot identity changes. All windows share one serialized recovery
worker; controls disable while it runs.
The panel scrolls so errors and actions stay reachable in smaller windows.

The interaction references are T3's explicit connection phases, Paseo's persistent
synchronization feedback, Orca's separate check/apply states and OpenCode v2's
reload recovery action. The existing Python controller remains the local prototype
launcher; this is not a packaged auto-updater. UI/source paths and Python must be
available on the development machine. Client updates are applied with Reload client;
only daemon and supervisor build identities are compared by Check builds.

`python3 scripts/test_recovery.py` checks local build identities, missing-daemon
recovery, shell-preserving handoff, explicit supervisor replacement and profile
isolation using a disposable real PTY. `scripts/test_runtime.py` additionally covers
crash recovery, stale ownership, migration and saved layouts. This build passed
38 Rust tests and both lifecycle integration suites. Native checks verified daemon
restart, replacement confirmation/cancellation, supervisor replacement, in-place
client reload, direct launch with a missing daemon, workspace restoration and
terminal typing after recovery and daemon handoff. Full VoiceOver coverage and
long-duration performance under periodic build checks remain unverified.

## Provider handoff validation

`python3 scripts/test_agent_handoff.py` uses real adapters and the Claude bridge with
controlled provider processes. It verifies planned and crash replacement during
streaming and tool execution, identical provider/tool PIDs, exact recovered text,
stable approval/question identities, one reply per request, cancellation, large
approval payloads, transient connection recovery and visible supervisor-loss failure.
The runtime tests cover failed handoff publication; unit tests cover command admission,
lost replies, concurrent cancellation, cursor rollback and bounded replay exhaustion.
The worktree suite verifies that an Agent alone protects its worktree across a crash.

`python3 scripts/test_agent_handoff_live.py --run` is an explicit opt-in check that
consumes model usage. It passed with authenticated Codex and Claude: each completed
one text-only model turn across daemon replacement, with the same provider process,
run and session identity and one user prompt. These live checks did not approve tools;
tool and permission failure cases use deterministic fixtures.

The provider-handoff build passed 35 Rust tests, five Claude bridge tests, and the
Agent handoff, mixed-provider, session, runtime and Worktrunk integration suites.
The release bundle builds successfully. No dependency or account configuration changed.

At ten workspaces, the 15-second steady-state benchmark passed: UI timer lateness
p95 14.51 ms, provider-to-render entry p95 62.22 ms, and control RPC p95 2.05 ms.
Client CPU was 84.56% of one core, application daemon CPU 13.76%, and supervisor CPU
15.75%. Peak sampled steady-state RSS was 233 MiB for the client, 15 MiB for the
daemon and 57 MiB for the supervisor. Application recovery took about 0.13 seconds
and retained all ten provider PIDs; this measures backend readiness, not full UI restore.

The provider-handoff baseline exposed a reconnect allocation problem: sampled RSS
reached 860 MiB in the client and 761 MiB in the supervisor. The preceding
terminal-only build also showed large peaks (974 MiB client, 838 MiB supervisor).
The compact snapshot change below addresses that allocation amplification.
Baseline results are in `work/runtime-benchmark/provider-handoff/results.json`
relative to the task directory. No model/network latency is included.

The design keeps T3's provider-adapter separation, OpenCode v2's explicit runtime
ownership, Paseo's instance checks, Orca's conservative replacement rules, Ghostex's
stable transcript identities and Herdr's bounded, versioned handoff approach. ADE
keeps its supervisor alive instead of transferring live provider file descriptors.
No new package dependency was required.

## Compact snapshot reconnect validation

The real-PTY reproducer isolated allocation amplification in JSON snapshot encoding:
each snapshot byte became a separate `serde_json::Value` on both sides of the
connection. Negotiated base64 now avoids that expansion. The Ghostty snapshot
format, terminal state and output ordering are unchanged. Old viewers still receive
byte arrays, and new viewers accept either encoding from a compatible supervisor.
An old supervisor therefore remains compatible but retains the old allocation cost.

This follows OpenCode v2's base64 checkpoint representation and Herdr's bounded
framing principle. ADE retains its existing JSON framing and size limits. The
already locked `base64` 0.22.1 package is now a direct dependency; no version upgrade
was needed. Decoding rejects invalid, conflicting and oversized representations.

The minimal test failed twice before the change: a roughly 250 KiB snapshot raised
supervisor RSS by about 19 MiB. With compact encoding, twelve reconnects raised RSS
by about 2.2 MiB, below its fixed-plus-payload budget. This diagnoses allocation
amplification and retained RSS, not a proven continuously growing leak.

The native ten-window workload used 50 seeded responses per Agent, 20 deltas per
second per Agent and 260 KiB/s of PTY output per workspace. It ran 15 seconds of
steady streaming followed by three client reconnects while streaming continued:

| Phase | Client peak RSS | Supervisor peak RSS |
| --- | ---: | ---: |
| Steady streaming | 255 MiB | 57 MiB |
| First reconnect | 307 MiB | 72 MiB |
| Second reconnect | 325 MiB | 84 MiB |
| Third reconnect | 340 MiB | 95 MiB |

The historical single-reconnect baseline was 860/761 MiB; the repeated run lasts
longer and accumulates more history. All reconnect memory budgets passed, the
transcript matched exactly, and daemon replacement retained provider processes.
Steady-state UI timer lateness p95 was 15.44 ms, provider-to-render entry p95 was
56.04 ms and control RPC p95 was 1.97 ms. The later reconnects still showed timer
lateness p95 of 17.42 and 19.88 ms; the timing gate covers steady state, not recovery.
Native snapshot decoding still runs on the UI thread. These short local sampled-RSS
measurements exclude GPU allocation and do not establish long-duration memory
stability. Results: `work/runtime-benchmark/compact-reconnect/results.json`.

Validation passed 37 Rust tests, the legacy/compact binary transport integration,
twelve real-PTY reconnect cycles and the three-cycle native benchmark. From the
task directory, reproduce the memory and native checks after a release build:

```sh
python3 scripts/test_reconnect_memory.py --cycles 12
python3 scripts/benchmark_runtime.py --windows 10 --seconds 15 --history 50 --reconnect-cycles 3 --output work/runtime-benchmark/compact-reconnect
python3 scripts/check_runtime_benchmark.py work/runtime-benchmark/compact-reconnect/results.json
```

## Structure

- `src/main.rs`: GPUI Kit windows, WKWebView, shared snapshot subscription,
  background command acknowledgement, native terminal placement. `--windows N`
  selects 1–10 unsaved windows for repeatable testing.
- `src/bin/ade-daemon.rs`: application admission, provider/session routing, terminal
  byte relay, restored worktree leases and boot-fenced restart checks.
- `src/agent_runtime.rs`: provider ownership, command receipts, bounded event journal
  and reconnecting provider transport.
- `src/bin/ade-runtime.rs`, `src/bin/terminal_host.rs`: runtime admission and PTY ownership,
  bounded output, Ghostty recovery, terminal subscriptions and resize ownership.
- `src/runtime.rs`, `scripts/runtime.py`: supervisor ownership, expiring handoff,
  protocol validation, stable launch and in-place data binding.
- `src/model.rs`, `src/store.rs`: durable identities, ordered messages, idempotent
  submissions, atomic recovery and versioned SQLite schema.
- `src/sessions.rs`: daemon-owned Conversation state and bounded Agent event batches.
- `src/worktrees.rs`: neutral Worktrunk adapter, persisted operations, configuration,
  repository locks, process supervision and runtime/ownership guards.
- `src/worktree_ui.rs`: native Worktrees window and asynchronous lifecycle controls.
- `src/provider.rs`, `src/rpc.rs`: provider-neutral events and a bounded, owned
  JSON-lines transport with process-group cleanup.
- `src/codex.rs`, `src/claude.rs`, `providers/claude/bridge.mjs`: provider-specific
  session/history, streaming, approval, question and cancellation handling.
- `src/client_state.rs`: reconnecting projections, bounded history pages, late-snapshot
  reconciliation and serialized window writes.
- `src/bin/ade-attach.rs`: internal input/resize adapter and diagnostic commands.
  It never relays VT output to an outer terminal, which could generate extra replies.
- `src/terminal.rs`, `native/terminal.m`: main-thread-only Ghostty surface,
  AppKit input/IME boundary, focus and visibility notifications.
- `src/terminal_state.rs`, `src/terminal_state.c`: headless libghostty-vt model
  with bounded history, continuation tracking and binary snapshots. ANSI snapshots
  remain available as diagnostic JSON, not an interactive outer-terminal path.
- `src/terminal_stream.rs`: bounded per-window output queue, protocol validation,
  output offsets and ordered snapshot/output/resize delivery.
- `build.rs`: native compilation and linking. The renderer links only into the
  client; the headless parser links only into the runtime supervisor.

GPUI Kit and GPUI Wry use the matching local source under
`../../work/vendor/gpui-kit` (0.6.5, GPUI snapshot 0.3.6). The browser wrapper uses
`lb-wry` 0.53.3. The daemon uses portable-pty 0.9, rusqlite 0.40.2 (bundled SQLite), uuid and serde_json. Client updates use bounded
async-channel notifications; no periodic UI polling is required. Cargo.lock pins
resolved dependencies. Native terminal provenance and licenses are in
`native/README.md` and the adjacent notices.

## Reference decisions

The evaluation clones were read without modifications:

Each reference contributed a specific decision verified against its source:

| Reference | Source in the evaluation clone | Applied decision |
|---|---|---|
| T3 Code | `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | Separate commands, notifications and approval requests; correlate provider thread/turn/item IDs. We deliberately reject its fresh-thread fallback after a failed resume. |
| opencode v2 | `packages/core/src/persistent-pty/daemon.ts`, `packages/client/src/pty-handoff.ts`, `packages/cli/dev/tui.ts`, `session/store.ts` | Separate persistent PTY ownership from replaceable application logic; validate identity and expiring handoff tickets; keep UI reload independent of process lifetime. Durable execution records identify interrupted work. |
| Paseo | `packages/server/src/server/agent/agent-storage.ts`, `workspace-registry-model.ts` | Separate ADE Conversation IDs from provider resume handles and workspace placement. |
| Orca | `src/main/persistence/loading-store/terminal-binding-recovery.ts`, `runtime-authored-workspace-session-fields.ts` | Distinguish a lost client connection from a terminated process; the daemon alone authors runtime state. |
| Ghostex | `packages/gx-chat-core/src/session/persistence.rs`, desktop OS CLI app-state persistence | A late restored snapshot cannot overwrite newer live state; window geometry writes are debounced. |
| Herdr | `src/persist/restore.rs`, `snapshot.rs` | Keep durable records when restoration fails, validate versions and preserve explicit failure states. Its vendored Ghostty remains the aligned parser/renderer source. |

The session implementation is written for ADE rather than copied wholesale. The
native Ghostty source/patch has separate provenance and notices. The clones live
under `~/work/ade-evaluation-2026-09-24` and remain read-only.

The renderer and daemon parser now use the same Herdr-vendored Ghostty source.
The native bridge compiles against its matching header. The original integration
patch is retained in `native/ghostty-snapshot.patch`; build instructions and
remaining response-ownership limits are in `native/README.md`.

## Session validation

```sh
# Build first using this task's configured Rust toolchain.
cargo test --locked --lib --bins
python3 scripts/test_sessions.py
python3 scripts/test_runtime.py
python3 scripts/test_providers.py
pnpm --dir providers/claude test
python3 scripts/test_binary_transport.py
python3 scripts/test_terminal_ownership.py
```

`test_sessions.py` uses a deterministic stdio fixture and isolated temporary data.
It covers prompt deduplication, late RPC replies/errors, ordered streams, approval
isolation, scoped permission replies, questions, cancellation, two workspace PTYs,
exclusive writer locking, interrupted recovery and resume reconciliation. It makes
no model calls. `ADE_TEST_DAEMON` selects a different built daemon.

`test_runtime.py` exercises real PTYs across planned replacement and SIGKILL,
wrong tickets, stale boot IDs, active-Agent refusal, active-writer adoption refusal,
in-place schema migration, saved layouts and explicit shell replacement.
`test_providers.py` runs six mixed provider connections through the real adapters
and Claude bridge with deterministic fake CLI/SDK responses. It checks config,
approvals, questions, cancellation, UUID deduplication and failed resume. Claude's
installed CLI and official SDK have also completed a real initialization handshake;
that check sends no prompt and does not validate a paid model turn.

A separate live Codex smoke test returned `ADE_LIVE_OK` through this adapter using
the installed CLI login. After a daemon restart, it resumed with the same provider
thread and message IDs. That confirms real transport, streaming and resume; deterministic
fixtures exercise the less predictable approval and failure paths.

The native UI was exercised with two restored windows, Conversation selection,
Send, Resume, command denial and multi-question keyboard input. Closing one window
retained the sibling; closing the last exited the client while retaining its record
and daemon Conversation. The child-panel `--ui-smoke` test also passed on this build.

## Native validation from the preceding milestones

- All three binaries compile and link on this Mac.
- Daemon unit test: bounded history and slow subscriber removal.
- Protocol smoke: real shell commands, filtered GUI subscriptions, completed
  simulation, resize ownership and adapter terminal settings restoration.
- All clients can disconnect while the same shell PID and shell variable survive.
- Native Ghostty and WKWebView render together inside GPUI.
- Native terminal keyboard input executes a real shell command.
- Browser text input and JavaScript button interaction work.
- The client opens new windows and selects a shared durable Conversation.
- A native child panel composes above live terminal and browser views.
- Automated `--ui-smoke` closes a parent with its panel, confirms both registry
  entries disappear, and verifies the sibling workspace survives.
- Client process relaunch preserves the daemon and shell.
- Closing one window releases its attachment; closing the last window exits the
  client with zero daemon subscribers and the shell still running.
- Restarting the daemon reconnects the UI and recreates both terminal attachments.

Binary recovery verification:

- Eleven Rust tests pass, including both screen buffers, history, partial ANSI/UTF-8/OSC,
  repeated recovery before a sequence completes, corruption/truncation rejection,
  continuation overflow, output gap detection and subscriber cleanup.
- The standalone native surface imports those binary fixtures, resumes partial
  input, preserves live state when a truncated snapshot is rejected, renders and
  tears down. Local pixel resize preserves an 80-column terminal; an authoritative
  daemon resize changes it to 40 columns.
- `python3 scripts/test_binary_transport.py` starts a temporary real-PTY daemon
  and verifies snapshot-before-output ordering, byte offsets, reconnect and GUI
  payload isolation. Build the debug binaries before running it.
- The full app visibly restored the detached fixture after 580,308 output bytes.
  Returning from the alternate screen restored the original shell screen and
  accepted keyboard input. The browser rendered beside it.

Earlier ANSI-recovery tests also passed, but the native app now uses binary
snapshots rather than that compatibility path.

`scripts/recovery_fixture.py` reproduces the native recovery check. Run it
inside the daemon terminal, close and reopen the client, and verify the green
fixed marker and `RECOVERY_DONE` text. Press Enter to leave the fixture. Its
repeated updates exceed the raw ring without erasing the fixed marker.

Run the native window lifecycle test against an existing daemon:

```sh
ADE_SOCKET="$(cd ../.. && pwd)/work/runtime/ade-v3.sock" \
  ../../work/target/release/ade-client --ui-smoke
```

Measure a process after warm-up, with no UI interactions during the sample:

```sh
python3 scripts/measure.py --pid CLIENT_PID --seconds 30
```

The previous four-percent CPU sample was not a stable warmed-up baseline. A
later debug sample measured 0.6% of one core; release samples measured 1.03–1.43%
with roughly 98–108 MiB RSS before eliminating redraws for unchanged metrics.
These observations do not prove a release-build speedup. Window visibility and
focus affect native rendering. Process-only RSS excludes WebKit helpers, GPU
allocations and the shell. The client now coalesces notifications and skips
redraws for heartbeat counters that are not displayed.

Earlier ANSI-build samples (30 seconds each; not remeasured after binary recovery): inactive windows measured no
CPU-time increase at `ps` resolution with 83 MiB client RSS; an active workspace
with its shell cursor visible measured 1.70% of one core and 101 MiB client RSS.
The daemon used about 30 MiB RSS after the detached-output fixture. These states
are intentionally reported separately; the inactive result must not be presented
as active-use CPU consumption. No before/after speedup is established.

## Terminal ownership

The daemon is the sole VT query responder. Its parser collects replies into a
bounded queue serviced by one PTY writer. Client surfaces retain keyboard, mouse,
user copy and paste, but suppress automatic query, focus, size and clipboard
side effects from their renderer. Snapshot replay therefore cannot resend an
already handled terminal query. Queue admission never blocks the output reader.
If a child floods queries without reading stdin, a full 64-batch queue drops
new replies, increments `reply_dropped_bytes`, and sends one visible warning.
The shell may then be missing replies, but snapshots, metrics and output remain
responsive. Input itself can still wait for the PTY writer until the child reads.

The daemon supplies cursor, device-attribute and size replies. Size queries use
the current controller's rows, columns and pixel geometry. Its device attributes
advertise VT220/color support, without advertising programmatic clipboard access.
OSC clipboard requests do not access the host clipboard; user copy/paste remains
available in the native renderer. Focus-report forwarding is not implemented;
viewer focus changes cannot inject competing reports into the shared shell.

Each input adapter registers its own geometry. The first becomes resize owner;
new viewers remain observers. Typing or an explicit claim selects that controller.
Disconnect transfers ownership to the most recently used remaining controller.
If none has claimed ownership, the most recently registered observer wins.
Input bytes share the daemon's PTY writer mutex, so concurrent writes cannot
interleave within one request.

`scripts/test_terminal_ownership.py` exercises a real PTY with 0, 1, 4 and 10
native viewers. Cursor and device-attribute queries receive exactly one response
each. It also checks observer registration, typing claims, owner disconnect and
restoration of the remaining viewer's geometry. Twelve passive handoffs verify
deterministic selection. A raw-PTY query flood checks output draining and daemon
responsiveness under reply backpressure. The cursor test was observed red
with the reply callback removed and green after restoring it. The independent
native ownership smoke verifies no automatic replies/clipboard effects while
key, text, mouse, copy and paste remain functional.

## Repeatable performance harness

Build release binaries, then run without concurrent builds/tests:

```sh
python3 scripts/benchmark.py --seconds 15
```

The harness starts temporary daemons and 1, 4, then 10 real native windows. Each
window contains a Ghostty view and a local WKWebView. It measures idle use,
approximately 260 KiB/s of sustained PTY output with input probes, actual window
resize and reconnect after 60,000 history lines. It preserves unrelated daemons.
Windows overlap with one foreground window; this is not ten simultaneously
visible terminals or ten independent shell sessions.

CPU uses `ps` CPU-time deltas (100% means one logical core). Memory is peak sampled
RSS, not physical footprint or GPU allocation. Client, daemon, attach processes,
shell/workload and newly launched WebKit helpers are reported separately. WebKit
XPC helpers have launchd as their parent, so their attribution uses new PID sets;
unrelated WebKit launches during a run can contaminate that group.

`ADE_BENCH_LOG` enables bounded client timings. Input latency starts at the
harness's daemon IPC request and ends after native state application. It excludes
physical keyboard delivery and screen presentation. Snapshot restore measures
native decode/application separately from process-launch-to-all-viewers-restored.
Resize-to-GPUI-frame callbacks measure the GPUI path, not final display scanout.
Counts are capped at 100,000 samples per metric and exposed in the result.

`ADE_GPU_BENCH_LOG` enables actual Ghostty Metal command-buffer GPU durations.
Those timings exclude GPUI rendering, CPU encoding, queue wait and presentation.
Histogram percentiles are upper bounds with 0.01 ms bins. Instrumentation adds
some overhead; snapshots and telemetry are local test artifacts under `work`.
Terminal failures are recorded explicitly rather than hidden by reconnect.

## Baseline before the font-cache fix

Measured on this Mac: Apple M4, 10 logical cores, 24 GiB RAM. Release build;
15-second idle/output/reconnect samples and 7.5-second resize samples. No builds
or other test suites ran concurrently. One foreground window, overlapping views
of one shared terminal, local static browser fixtures. CPU percentages below use
one logical core as 100%. They are not percentages of the whole machine.

| Viewers | Idle client CPU | Streaming client CPU | Input→native apply p95 | Ghostty GPU p95 upper bound | Resize→GPUI callback p95 | Large-history reconnect, all viewers |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1.06% | 9.48% | 0.50 ms | 1.16 ms | 46.00 ms | 0.68 s |
| 4 | 0.79% | 67.45% | 0.63 ms | 1.25 ms | 37.24 ms | 0.90 s |
| 10 | 1.18% | 590.10% | 8.00 ms | 2.61 ms | 45.08 ms | 1.37 s |

Peak sampled RSS after the large-history reconnect (MiB; GPU allocations excluded):

| Viewers | Client | Daemon | WebKit helpers | Attach processes |
|---:|---:|---:|---:|---:|
| 1 | 143.0 | 40.0 | 72.7 | 18.1 |
| 4 | 248.2 | 39.9 | 170.4 | 62.8 |
| 10 | 382.6 | 40.7 | 342.0 | 157.1 |

No terminal errors or GPU command-buffer errors were recorded. Daemon streaming
CPU was 2.24–3.77% of one core. Native snapshot decode/application was under 5 ms
per view in this run; process creation and setup dominate the reconnect metric.
The ten-viewer CPU increase prompted a symbolized profile. The largest active
stacks were `SharedGrid.getIndex` and `renderGlyph`, which acquired the same
shared lock for every character/glyph across renderer threads. Disabling GPU
timing did not remove the slowdown. The fix and new results follow below.
Baseline results remain in `work/benchmarks/ownership-final/results.json`.

## Font-cache fix

The native patch adds bounded thread-local caches in front of those two shared
lookups. Misses still use the original locked path. Each grid has a unique
lifetime ID, preventing stale entries after font changes or address reuse.
The change keeps rendering cadence, fonts and output delivery intact.

The short regression measured 578% before the fix and 104–112% after it.
Relinking the previous archive made the same CPU assertion fail again at 355%;
restoring the optimized archive returned it to green. Run it on an otherwise
idle Mac after building release binaries:

```sh
python3 scripts/test_render_scaling.py
```

The two-core ceiling is a regression guard on this Mac, not a portable performance
budget. The full harness provides longer measurements and is the comparison to
use. All 85 focused native font tests passed, including grid replacement, cache
collisions, styles, missing characters and atlas growth. Native ownership and
snapshot recovery smoke tests passed, as did the 0/1/4/10-viewer real-PTY suite.

## Release results after the font-cache fix

Same Apple M4, 24 GiB, macOS 26.6.1 and 15-second phases as the baseline.
All viewers share one PTY and use the same output workload.

| Viewers | Idle client CPU | Streaming client CPU | Input→native apply p95 | Ghostty GPU p95 upper bound | Resize→GPUI callback p95 | Large-history reconnect |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.92% | 9.18% | 0.47 ms | 3.07 ms | 43.66 ms | 0.51 s |
| 4 | 1.13% | 29.58% | 0.46 ms | 1.33 ms | 2.79 ms | 0.82 s |
| 10 | 1.40% | 69.97% | 0.82 ms | 3.02 ms | 42.42 ms | 1.19 s |

Peak sampled RSS after large-history reconnect (MiB):

| Viewers | Client | Daemon | WebKit helpers | Attach processes |
|---:|---:|---:|---:|---:|
| 1 | 150.8 | 37.1 | 75.5 | 18.5 |
| 4 | 255.8 | 38.3 | 173.3 | 73.8 |
| 10 | 307.6 | 18.7 | 333.2 | 155.2 |

Ten-viewer client CPU fell by 88% in this full run; p95 input-to-native apply
fell from 8.00 ms to 0.82 ms. Short regression runs ranged from 104% to 112%
after the fix, so these are measured samples rather than a fixed CPU guarantee.
The ten-viewer streaming phase recorded 9,031 completed Ghostty GPU command
buffers, confirming that rendering continued. GPU durations did not consistently
improve; this is a CPU contention fix, not an input-to-photon or GPU speed claim.
No terminal or GPU command-buffer errors were recorded.

Full results: `work/benchmarks/render-cache-final/results.json`. The same
attribution, sampling and latency limitations described above apply.

## Concurrent Conversations and independent terminals

Run after a release build, without concurrent builds/tests, from this directory:

```sh
python3 scripts/benchmark_runtime.py --windows 1 4 10 --seconds 15 --history 50 --output ../../work/runtime-benchmark/final
python3 scripts/check_runtime_benchmark.py ../../work/runtime-benchmark/final/results.json
```

This harness uses real GPUI windows, native terminals, WKWebViews, daemon IPC,
SQLite transactions and Codex stdio adapters. Each workspace has an independent
shell and synthetic provider. Each provider seeds 50 historical responses, then
emits 20 deltas/second while its terminal emits approximately 260 KiB/second.
No model or network latency is included. Windows overlap with one foreground
window; browser pages are static fixtures. These are 15-second steady streaming
samples, not a long-duration soak or a claim about complex websites.

On the same M4 Mac, the first ten-workspace run used 91.02% of one core in the
client and recorded 22.87 ms p95 lateness for a 100 ms UI timer. Every Conversation
update invalidated every window. Following T3's scoped thread subscription design
(`packages/client-runtime/src/state/threads.ts`, `subscribeThread`), the client now
invalidates a window only for its selected Conversation or shared sidebar/connection
changes. Daemon delivery and persistence are unchanged. Late history snapshots
still advance the local projection revision, even when their server revision is
older. Regression tests cover unrelated tokens, sidebar status, own tokens and
late history adoption.

Pre-supervisor release baseline (100% CPU means one logical core):

| Workspaces / Agents / windows | Client CPU | Daemon CPU | UI timer lateness p95 | Provider→render entry p95 | SQLite transaction p95 | Client reconnect |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 16.14% | 3.95% | 5.10 ms | 32.39 ms | 0.85 ms | 1.04 s |
| 4 | 39.35% | 10.52% | 8.75 ms | 47.12 ms | 0.36 ms | 2.08 s |
| 10 | 81.52% | 21.76% | 12.59 ms | 53.97 ms | 0.36 ms | 3.07 s |

The ten-workspace client CPU fell about 10%; p95 timer lateness fell about 45%.
Provider-to-render p95 at ten workspaces stayed around 54 ms. An intermediate
repeat measured 80.98% client CPU and 14.35 ms timer lateness. These are local
observations, not fixed performance guarantees. The regression guard fails the
original run and passes the final run: UI timer p95 ≤16.67 ms, provider-to-render
entry p95 ≤100 ms, daemon control RPC p95 ≤20 ms, exact final transcript matching.

Peak sampled streaming RSS (MiB; columns are separate process groups, not physical
footprint; synthetic provider/shell memory is not an estimate of real Codex):

| Workspaces | Client | Daemon | WebKit helpers | Attach processes | Fixture providers / shells |
|---:|---:|---:|---:|---:|---:|
| 1 | 123.9 | 18.7 | 72.7 | 11.7 | 29.2 |
| 4 | 158.8 | 34.2 | 144.6 | 37.7 | 110.9 |
| 10 | 258.3 | 63.7 | 323.5 | 94.1 | 276.1 |

All completed transcripts matched the synthetic provider text exactly after
client disconnect/reconnect. Forced daemon termination during new turns followed
by restart/resume succeeded at every concurrency level (0.22–0.25 s to synthetic
provider readiness). That pre-supervisor build did not preserve shell processes
across daemon death; the current runtime supervisor does.
The real Codex check separately returned `ADE_LIVE_OK` and retained its provider
thread and message IDs after daemon restart/resume. All 24 Rust tests and the
session integration suite passed for that baseline.

The earlier terminal-only supervisor build passed 29 Rust tests, five Claude bridge tests and
the runtime, provider, session, worktree, review, terminal and native window
integration checks. A live daemon replacement retained the shell PID and accepted
native terminal input after the client reconnected. A real Claude SDK initialization
also passed; no live Claude model turn was run.

The first terminal-only supervisor benchmark at ten workspaces missed the 16.67 ms steady-state
UI timer budget with 19.02 ms p95 lateness. The final-build repeat passed with
13.78 ms timer lateness, 56.75 ms provider-to-render entry and 1.75 ms control RPC
p95. Client CPU was 83.52% of one core; application daemon CPU was 12.68% and runtime
supervisor CPU was 12.16%. Final transcripts matched exactly. These are short local
samples, not a guarantee: the reconnect phase recorded 23.06 ms cumulative timer
p95 and is outside the steady-state gate. Input-to-photon latency remains unmeasured.

Latency samples are cumulative since process startup, including warm-up; process
CPU/RSS and control RPC measurements cover the named phase. Client reconnect waits
for all native terminal restores and Conversation render markers; telemetry flushes
once per second, so this readiness time is quantized. Per-view native restore and
launch timings remain in the raw results. The GPUI next-frame callback is retained
as a diagnostic, not a display-latency assertion: it runs on a later frame-loop
iteration and inactive windows throttle it. At ten workspaces it was 103 ms p95
in the final streaming sample. Render entry measures when view construction starts,
not layout completion or visible text. Physical input-to-photon, GPU allocations,
long-duration memory stability and large real-provider histories remain unmeasured.

Results: `work/runtime-benchmark/baseline/results.json` and
`work/runtime-benchmark/final/results.json` relative to the task directory.

The reference review also identified opencode-v2's timeline virtualization and
Paseo's per-Agent reducer batching/viewed-session synchronization as candidates
for larger histories. Orca's serialized journal batches and writer fencing inform
persistence boundaries. No new persistence batching was added: SQLite transaction
p95 remained below 1 ms. These complement the existing Ghostex replay and Herdr
native-terminal work; they are not claims of identical implementations.

## Worktree lifecycle

The **Worktrees** button opens a separate native window. Load a repository, create
from a new branch/base or check out an existing branch, then open the resulting
checkout as an ADE workspace. Repository loading refreshes the cached inventory.
Removal requires a second choice: keep the branch, or delete it only if Worktrunk
considers it merged. The resulting branch outcome is reported separately from
successful checkout removal.

This uses the installed `wt` executable, tested with Worktrunk **0.74.0**, through
its JSON CLI. `ADE_WT_BIN` selects another executable. Worktrunk is needed only for
lifecycle commands; an absent/incompatible binary does not stop the app or daemon.
List JSON schema 2 is explicitly selected and validated. No Worktrunk source,
personal shell aliases, editor launchers, port conventions, environment setup or
package-install commands are copied into ADE. Worktrunk remains an external
prototype dependency; bundling/distribution and a wider version matrix remain.

Defaults and customization:

- Each repository has a persisted configuration, shared by all of its windows.
  It can select a worktree path template, an explicit user config file, an explicit
  project config override and whether hooks run. Blank config fields select an
  ADE-owned empty user/system config and the repository's usual project config.
- Ambient `WORKTRUNK_*` configuration overrides and shell integration directives
  are removed from lifecycle subprocesses. Direct argument arrays replace shell
  command construction. Lifecycle commands always run from the primary checkout,
  with mutations serialized by canonical Git common directory.
- Hooks default to disabled. This passes `--no-hooks` and disables Git hooks for
  that invocation. Enabling hooks opts into the explicitly selected user config,
  repository Git hooks and Worktrunk-approved project hooks. ADE never passes
  `--yes`, silently approves project commands or edits external configuration.
  If Worktrunk requests project approval, review the commands with Worktrunk's
  approval tooling using the same config paths, then retry deliberately.
- Worktrunk validates configuration before lifecycle operations. Blocking setup
  belongs in `pre-start`; `post-start` is background work. Successful checkout
  creation is not a claim that all background provisioning has finished.
- The API exposes operation timeouts from 5 to 300 seconds, defaulting to 60.
  Forced dirty removal requires both `force: true` and `confirm_path` matching
  the canonical path. The UI uses ordinary removal. Forced deletion of unmerged
  branches is not exposed.

The daemon records intent before execution in a separate `sessions.worktrees/`
SQLite database beside the Conversation database. Request IDs are idempotent;
reusing one with different parameters fails. Results retain bounded stdout/stderr
and elapsed time, while the current inventory is cached. Routine snapshots omit
full logs and bound error excerpts; `worktree.operation` retrieves the full receipt. The UI polls only while
its operation is running. `catalog.get` and Agent streams do not wait for setup.
A deliberately slow setup hook left sampled catalog RPCs under 1 ms on this Mac;
this is a local observation, not a general Git or checkout performance guarantee.

Removal protects live ADE terminals and Agents. Exit the checkout's shell and
use **Disconnect Agent** after cancelling/completing a turn before removing it.
Conversations and workspace records are retained for history. External checkouts
can be opened but are not silently adopted for deletion. ADE-created checkouts
carry a generation token in their Git administration directory; removal rechecks
both the token and the target's Git directory. Dirty worktrees, primary checkouts,
locked Git worktrees and foreign ownership are not bypassed by normal removal.
There is no recursive-delete fallback and no automatic process reaping.

A failing hook or timeout is not treated as rollback. The daemon refreshes actual
Git state and preserves a partially created checkout for inspection. A daemon
restart marks unfinished operations `interrupted` and never reruns them. A small
supervisor holds the repository lock while a surviving Worktrunk process finishes;
the lock is not inherited by Git background file watchers. Refresh then reconciles
the inventory. If the crash preceded ownership registration, the discovered
checkout remains external rather than guessing ownership; inspect the receipt
and manage it with the original `wt` tool. Checkouts missing on disk remain
visible in ADE's durable workspace history.

Daemon RPCs (newline-delimited JSON over `ADE_SOCKET`):

| Operation | Required fields / behavior |
|---|---|
| `worktree.repository` | `path`; returns stable repository ID and cached state |
| `worktree.get` | `repository_id`; cached inventory, settings and latest 100 operation receipts |
| `worktree.configure` | `repository_id`, `config`; replaces configuration, rejects changes during an operation |
| `worktree.refresh` | `repository_id`, `request_id`; asynchronous inventory refresh |
| `worktree.switch` | IDs above, `target`; optional `create: true`, `base` |
| `worktree.remove` | IDs above, `path`; `delete_branch: "keep"` (default) or `"merged"`; explicit force controls described above |
| `worktree.operation` | `repository_id`, `request_id`; retrieve any full receipt, including command logs |
| `agent.disconnect` | `conversation_id`; stop an idle provider and release its checkout lease |

Configuration fields are `user_config`, `project_config`, `path_template` (optional
strings), `hooks` (boolean), and `timeout_seconds` (integer). Unknown fields fail.
Settings take effect on the next lifecycle operation; other app behavior does not
inherit them. Operations return quickly with a running receipt; read cached state
until the receipt is `succeeded`, `failed` or `interrupted`. Exit status, refreshed
inventory and branch outcome are distinct pieces of evidence.

Reference decisions were checked against all six clones:

| Reference | Applied decision |
|---|---|
| opencode-v2 `packages/core/src/worktree/strategies.ts` | Keep lifecycle behind a daemon interface, independent of client components. |
| Orca `src/main/git/worktree-removal.ts`, `worktree-create-preparation.ts` | Recheck ownership before removal and preserve evidence after partial failure. |
| T3 Code `apps/server/src/project/WorktreeSetupTracker.ts` | Separate long-running operation state from usable checkout state; persist our receipts across restart. |
| Paseo `packages/server/src/server/worktree-core.ts` | Express new-branch and existing-branch intent explicitly. Avoid its forced-removal/recursive-delete defaults. |
| Herdr `src/worktree.rs` | Construct explicit argv and verify repository ownership rather than trusting a directory name. |
| Ghostex `server/src/typed_operations/worktree.rs` | Keep path validation in the backend; do not adopt its fixed family-directory layout. |

None supplies a standalone lifecycle package that removes the integration work.
Worktrunk's Rust library is explicitly unstable, so this build uses its CLI behind
one module. Merge, rebase, move, submodule controls, operation cancellation,
in-app hook approval and a second backend are outside this lifecycle milestone.
There is no claim that ADE exposes every Worktrunk command yet.

Verification:

```sh
ADE_TEST_DAEMON=../../work/target/release/ade-daemon python3 scripts/test_worktrees.py
ADE_TEST_DAEMON=../../work/target/release/ade-daemon python3 scripts/test_sessions.py
```

The first suite creates only disposable repositories. It covers real schema 2
output, ambient-config isolation, Git hook suppression, explicit custom paths,
new/existing branches, branch retention/deletion, dirty refusal, generation-token
changes, terminal/Agent leases, failed hooks, approval refusal, timeouts,
concurrency, restart recovery and
surviving-command locking. Temporary checkouts are removed through `wt`. Native
UI testing exercised repository loading, creation and opening a checkout window.

## Limits

- Native recovery uses a version-pinned experimental Ghostty binary format. It
  restores both screens, retained history and parser continuation. The daemon
  caps retained history at 4 MiB (page-granular) and continuation at 1 MiB. An
  oversized unfinished sequence fails explicitly until parsing reaches ground.
- `ade-attach` with no arguments shows usage. Raw outer-terminal viewing was
  removed because a second terminal parser could generate duplicate replies.
  Diagnostic snapshot/send commands and the native input adapter remain.
- Programmatic clipboard access and focus-report forwarding are disabled.
  Broader terminal-protocol parity still needs a dedicated compatibility suite.
- New viewers negotiate base64 snapshot bytes; older viewers retain JSON byte
  arrays. Both paths keep a 32 MiB message limit, bounded queues and an 8,257,536-byte
  decoded snapshot limit. The conservative limit reserves legacy JSON expansion
  and metadata space; oversized snapshots fail explicitly. The native decoder's
  separate 64 MiB ceiling is not reachable through this transport. Large native
  snapshot decoding still runs on the UI thread. Compact encoding reduces reconnect
  allocation amplification; it does not establish hostile-input safety or
  long-duration memory stability.
- Conversation messages are durable. Prompts are limited to 64 KiB, individual
  messages to 1 MiB, provider JSON frames to 16 MiB and visible history to 200
  messages per page. Resume currently reconciles full provider history; very large
  histories that exceed the frame budget fail explicitly. At most 16 Agents and
  64 workspace terminals can be connected. There is no Agent eviction UI yet.
- Child panels solve this overlay composition case. Arbitrary in-window GPUI
  menus still cannot paint over native views. Modal input blocking, outside-click
  dismissal and anchored popovers remain unimplemented. Embedded-page
  accessibility is not exposed in the GPUI tree.
- Codex and Claude adapters are implemented. Opencode and Oh My Pi adapters,
  advanced Worktree provisioning, SSH Hosts, Account routing, Dispatch and phone access remain.
  Provider process handoff across application-daemon replacement is implemented.
  Live supervisor replacement remains unimplemented.
  This is a local prototype, not a production session service.
- Window records include pane sizes, tab order, active tabs and commanded focus.
  Browser URLs include page-initiated navigation; browser history and form state
  are not restored after client restart. Browser profile management and tab drag
  reordering remain. Transcript paging currently uses the shared cache.
- IME and international keyboard behavior need broader interactive coverage.
- The earlier terminal tables and the concurrent Conversation table use different
  workloads and must not be compared directly. Long-duration memory stability,
  GPU allocation and input-to-photon latency remain unmeasured.

## Change review

The workspace header opens **Changes** in a native window. **New review window**
opens another projection of the same workspace. Each window keeps its own file,
area and hunk selection. Open Changes windows refresh every two seconds; the daemon
coalesces status requests for the same checkout for 750 ms. Closing all Changes
windows stops review polling. External Git changes appear on the next refresh.

- Separate staged and unstaged lists include partially staged files and conflicts.
- Per-file unified diffs load on selection. Diff lines use GPUI's virtual list;
  file lists are paged in groups of 40. Hunk navigation preserves Git's original
  range headers and no-newline markers. Horizontal scrolling supports long lines.
- Stage/unstage a whole file or an individual text hunk. Whole-file actions cover
  binary, mode, symlink and submodule changes. Resolve conflicts in the working
  file, then explicitly mark it resolved by staging it.
- **Commit staged files** requires a message and uses Git's configured identity,
  signing and hooks. It never stages extra files, amends, pushes, overrides identity,
  or bypasses hooks. Tests create commits only in disposable fixture repositories.

`review.*` RPCs route through `Sessions` to `src/review.rs`, outside the Conversation
mutex. The daemon resolves nested workspace directories to the Git checkout root.
Commands use literal pathspecs and argument arrays. Status uses porcelain v2 with
NUL delimiters; patches disable external diff and text conversion programs.
Hunk mutations re-read and compare the exact patch and index token before applying
it with `git apply --cached` (reverse for unstage). File actions check a status
revision; commit checks the reviewed index and HEAD token. These checks reject
stale views, but cannot fence an unrelated editor or Git process between checks;
Git's own index/ref locks remain authoritative for external concurrency.

Review reads and mutations share Worktrunk's repository admission gate and flock.
Their short-lived worktree leases also protect against ADE removal. A subprocess
supervisor retains the flock across daemon failure without passing it to Git's
background helpers. Up to eight repositories may run Git/lifecycle operations at
once. Contention returns an explicit busy response instead of blocking Conversation
or terminal processing.

Mutation intent and completion receipts live in `sessions.review.sqlite3` beside
session state. Every mutation requires a request ID; repeating the same request
returns its receipt, and changing its parameters is rejected. Startup marks pending
receipts interrupted. It does not replay commits or delete Git lock files. After an
interrupted commit, inspect history and refreshed status before submitting new intent.

RPC surface (all requests include `workspace_id`):

| Operation | Additional fields |
| --- | --- |
| `review.status` | Optional `force` bypasses the short status cache. |
| `review.diff` | `path`, `staged` |
| `review.stage`, `review.unstage` | `request_id`, `path`, reviewed `revision` |
| `review.hunk` | `request_id`, `path`, `staged`, diff `token`, zero-based `hunk` |
| `review.commit` | `request_id`, `message`, reviewed `index_token` |
| `review.operation` | `request_id` |

Known limits: UTF-8 paths/text only; a command's retained output is capped at 4 MiB,
with an explicit error on overflow. Whole-file staging remains available when a
patch is too large. Individual displayed lines are capped at 4,000 characters and
marked as shortened; the daemon retains the exact patch for validation/application.
Status supports up to 20,000 changed files. Git reads time out after 15 seconds,
staging after 30 seconds, and commits after 120 seconds. Interactive signing or
hooks may require using the terminal. Renames appear as deletion/addition pairs.
There is no inline editor, three-way conflict editor, arbitrary line selection,
commit history browser, or push/pull UI in this milestone. Review windows are
transient; workspace windows still use the existing durable layout restoration.

The implementation was compared against all six evaluation clones:

| Reference | Applied decision |
| --- | --- |
| Orca `src/main/git/source-control/staging.ts`, `file-diff.ts` | Literal paths, per-file reads and explicit staged/unstaged areas. |
| T3 `apps/server/src/vcs/GitVcsDriverCore.ts` | Bound diff work/output; keep expensive review work on the server. Temporary review indexes were considered but are unnecessary for single-file untracked previews. |
| Paseo `packages/server/src/utils/checkout-git.ts` | Handle unborn HEAD explicitly and surface limits. Its default add-all commit behavior is not used. |
| OpenCode v2 `packages/core/src/git.ts` | Explicit repository/index scope and machine-readable file lists. Its snapshot-index machinery stays outside this user-driven review flow. |
| Ghostex `server/src/typed_operations/git.rs` | Typed Git operations with literal paths and external diff programs disabled. |
| Herdr `src/app/git_refresh.rs` | Refresh on client demand and reuse status across views. |

Git semantics were checked against the official [status](https://git-scm.com/docs/git-status),
[diff](https://git-scm.com/docs/git-diff), [apply](https://git-scm.com/docs/git-apply)
and [commit](https://git-scm.com/docs/git-commit) documentation. No new dependency is
needed. Searching for official Git agent instructions/`llms.txt` did not identify a
separate agent integration contract.

`python3 scripts/test_review.py` exercises real Git through the daemon, including
unborn repositories, literal/newline paths, partial staging, reverse hunks, stale
requests, failed hooks, conflicts, binary/mode/deletion changes, nested workspaces,
commit idempotency, lifecycle exclusion, crash-held locks, interrupted receipts,
and oversized diffs. `ADE_TEST_DAEMON` selects the built daemon.

The launcher uses the stable runtime binding. The local binding points to the
adopted v6 data directory, now migrated to schema v3. With explicit user approval,
the v1 client, daemon and supervisor were stopped and runtime v2 launched against
that same directory. Its one saved window was retained; it contained no Conversations.
Native terminal input was verified in the replacement shell. Older state directories
and unrelated daemons are retained. Compatible application-daemon replacement now
preserves both terminals and provider processes through the separate supervisor.
