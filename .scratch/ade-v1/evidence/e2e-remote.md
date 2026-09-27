# E2E round 2: remote

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-5
Worker: ADE parallel build, E2E round 2, remote slice
Requirements: F121, F122, F124, F125, F126, F127, F129 and 11-S08 (11-remote); decision D13

## Outcome

Eighteen headless specs in `e2e/protocol/remote/` drive a real local profile daemon and real
remote profile daemons and runtimes through the SDK, the CLI and `@ade/client/remote`. A new
fake-ssh fixture plays each remote machine: a second scratch root with its own HOME, its own
installed ADE artifacts and a fixed host key. The specs exposed one product gap in this area:
F124 requires installing compatible artifacts, and nothing installed them. The new
`remote.host.install` effect command now does that. Seventeen specs pass. One is `test.fixme`,
because the remote backend does not check pairing tokens.

Register acceptance now passes headlessly for **F124, F125, F127 and 11-S08**. F121 and F122
wait on remote-side revocation. F126 waits on a feed carried over the remote transport. F129
waits on the preview forward process.

## Fixture

- `e2e/protocol/fixtures/fake-ssh.mjs` is new. It is copied first on PATH as `ssh` and
  `ssh-keyscan`, and it implements the subset ADE uses:
  - `ssh -G`.
  - Strict host-key checking against `UserKnownHostsFile`, `HostKeyAlias` and
    `HostKeyAlgorithms`, with OpenSSH's error text.
  - Remote commands run with `/bin/sh -c` inside the host root. They get the host's own
    environment and never the caller's. stdin, stdout and the exit code pass through.
  - `-N -L` Unix-socket forwards that honour `StreamLocalBindMask` and `StreamLocalBindUnlink`.
- Flag files cut a host's link (`link-down`) and hold remote commands (`hold-commands`). The fake
  logs every call to `calls.jsonl`. It never reads the real `~/.ssh`.
- `e2e/protocol/fixtures/remote-hosts.ts` is new. It exports a `test` with a `remote` fixture:
  - `RemoteLab` runs the fake ssh, creates hosts, and gives a profile the fake ssh on its PATH.
    It also creates SDK transports and disposes them at teardown.
  - `RemoteHost` holds a generated ed25519 key and exposes `changeHostKey`, `install(artifacts)`,
    `createProfile`, `linkDown`/`linkUp`, `holdCommands`, `repo`, `mockCalls` and
    `daemonStatus`.
  - Teardown owns every process under each host root, hands each remote runtime over, stops it,
    and then the harness survivor check runs as usual.
  - `remoteCall` is a typed operation over a remote transport.
- The remote profile daemons are started by the real `ade-control profiles start` over the fake
  ssh, from artifacts copied into the host root. They are never started by the fixture itself.

## Acceptance criteria

| Criterion | Spec | Result |
|---|---|---|
| F124 host add pins only the key matching the out-of-band fingerprint (ssh -G + ssh-keyscan); a mismatch lists presented fingerprints and records nothing | `bootstrap.spec.ts` › host add pins only the key matching … | pass |
| F124 add is idempotent; a different definition is refused; `local` is reserved; the registry survives a daemon SIGKILL | same | pass |
| F124 a changed host key is refused by probe, start and the SDK transport (`host_untrusted`) before anything runs on the host; the remote daemon keeps running | `bootstrap.spec.ts` › a changed host key is refused … | pass |
| F124 explicit key rotation: revoke, remove, add with the new fingerprint, reattach to the same running daemon | same | pass |
| F124 bootstrap names missing artifacts (no ade-control on PATH; no ade-daemon/ade-runtime beside it); start fails, installing, starting and writing nothing | `bootstrap.spec.ts` › bootstrap names the missing backend artifacts … | pass |
| F124 install compatible declared artifacts: explicit `remote install` copies this installation's ade-runtime, ade-daemon and ade-control (byte-identical) into `~/.ade/backend/<protocols>`; the host then probes compatible and starts from them; `.profile`, `.ssh` and the host's own bin are untouched; replay returns the stored reply; a second install is `already_compatible` and writes nothing | `bootstrap.spec.ts` › install copies this backend … | pass after fix; not possible before |
| F124 install refuses a backend the user named, an unpaired host, and a changed host key, writing nothing | `bootstrap.spec.ts` › install never replaces a backend the user named … | pass after fix |
| F124 start launches the remote profile daemon from the host's own install, attaches on a second start, replays a repeated operation ID without running anything, refuses the same ID with other parameters, relaunches after a remote daemon crash (runtime adopted), forwards no agent, X11 or other forwarding and copies no credentials | `bootstrap.spec.ts` › start launches the remote profile daemon … | pass |
| F124 fault: a duplicate start while the first is in flight is not run twice; the duplicate reports `unknown`, and a later replay returns the first result | `bootstrap.spec.ts` › a duplicate start while the first is in flight … | pass |
| F124 fault: a start interrupted by a local daemon SIGKILL is not replayed; the retry says to keep the same operation ID; the host is not `started`; a new ID leaves exactly one remote daemon | `bootstrap.spec.ts` › a start interrupted by a local daemon crash … | pass |
| F122 explicit pairing stores a token reference, never a token (a raw value is refused); repeat pairing converges, another reference is refused | `pairing.spec.ts` › pairing is explicit, revocation refuses … | pass |
| F122 revocation refuses start, placement and preview without reaching the host; it survives a daemon SIGKILL; remote work (daemon, workspace, placement) keeps running; the host cannot be removed while paired or while placements remain; pairing again is a new pairing | same | pass |
| F122 unknown host and unknown pairing are refused | `pairing.spec.ts` › a pairing is recorded for an explicit host only … | pass |
| F121/F122 the remote daemon rejects a connection presenting a revoked pairing | `pairing.spec.ts` › the remote daemon rejects a connection … | **fixme**: gap below |
| F121 the remote daemon and runtime open no TCP listener; the daemon socket is owner-only; the client reaches it only through a pinned, strict, owner-only (`StreamLocalBindMask=0177`) forward; hello identity matches the started daemon; an unpinned target with no known key is refused (no trust on first use) | `pairing.spec.ts` › the remote daemon listens only on an owner-only Unix socket … | pass |
| F125 remote workspace flow: `ade remote status` and `ade remote request workspace.open` reach the host daemon; `file.list`, `review.status` (Git) and a Codex turn run there with the host's own provider; the local catalog and local provider stay empty; placements resolve to the host | `transport.spec.ts` › a remote workspace flow runs on the host … | pass |
| F125 / 11-S08 link loss during a held turn reports `unknown`, refuses requests `not_sent`, sends nothing to the local daemon or providers; reconnect pins the same runtime; the original turn is still running with exactly one `turn/start`; cancel settles it | `transport.spec.ts` › link loss during a turn reports unknown … | pass |
| F124 / F125 remote daemon crash: a lost reply is `unavailable`, the transport reconnects after a restart to a new boot on the same runtime | `transport.spec.ts` › a remote daemon crash is reported unknown … | pass |
| F126 two hosts are labelled apart with their own sockets, profiles and runtimes; each daemon holds only its own workspace; a resource cannot be recorded on the other host; one host's link loss leaves the other connected; each reconnects to its own identity; the registry survives a restart | `placement.spec.ts` › several hosts are labelled apart … | pass |
| F126 cross-host cursor confusion | none | not covered: `session.subscribe` is not carried over the remote transport |
| F127 local placement needs no transport; remote placement needs the daemon's check and a connected transport to that host; retries and a daemon SIGKILL keep the choice; unregistered, failed-start and wrong-workspace placements are refused naming the chosen host only; a link loss refuses new work ("Nothing was sent to another host") until reconnect | `placement.spec.ts` › placement names its host explicitly … | pass |
| F129 preview capability: local is `direct`; a remote loopback URL is `ssh_forward` over a forward to that host's own daemon only; a URL naming another machine is not forwarded; an unreachable, unstarted or unknown host reports unavailable; remote device control is `unsupported` and never redirected locally | `placement.spec.ts` › the remote preview capability … | pass |
| F129 open a forwarded remote preview | none | not covered: the `ssh -L` preview forward process is not built |

## Product fix

- **Gap:** F124 requires installing compatible declared artifacts. Bootstrap only reported what
  was missing, so a host with no backend could never be started.
- **Fix:** `remote.host.install` is a new **effect command** with a receipt in
  `sessions.sqlite`. It needs a registered host with an active pairing. It runs in this order:
  1. Probe the host with the pinned key.
  2. Apply the pure `install_plan` decision in `crates/ade-daemon/src/remote.rs`. The outcome is
     `already_compatible` when a compatible backend exists. It is `failed` when the host
     platform differs from this installation's, or when the user named a `backend_path`. ADE
     never replaces a backend the user named.
  3. Upload ade-runtime, ade-daemon, then ade-control over the pinned ssh. Each goes to
     `~/.ade/backend/<application protocol>+<runtime protocol>/` through a temporary file, a
     chmod and a rename.
  4. Probe again through the installed ade-control.
- The outcome is `installed` only when that last probe is compatible. An upload that stopped
  after writing is `unknown`, and running the install again is safe.
- The install path is stored in a new `remote_host_installs` table, created with
  `CREATE TABLE IF NOT EXISTS`. `remote.host.remove` deletes that row. Probe and start use the
  path when `backend_path` is null.
- `RemoteHost` gains the optional `installed_backend_path`. No shell profile, PATH or other
  host configuration is changed.
- CLI: `ade remote install HOST_ID --request-id ID`. Its deadline is 510 s: two 45 s probes,
  three 120 s uploads and a 30 s margin.
- Refactor: `remote.host.start` and `remote.host.install` share `admit_effect`, the receipt and
  pairing admission.

## Operation tiers

| Operation | Tier |
|---|---|
| `remote.host.install` (new) | effect command |
| `remote.host.list`, `remote.host.add` | unchanged; `RemoteHost.installed_backend_path` added (optional) |

## Checks

- `pnpm check:static`: pass. The run covered rustfmt, the contract check, architecture, API
  parity, the SDK build, typecheck, Fallow, the JS build, the JS pure tests, Clippy and the
  legacy Rust tests.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/remote`: 17 passed, 1 skipped
  (fixme). It was run twice with the same result.
- After each run, `pgrep` found no `ade-daemon`, `ade-runtime` or fake ssh from this worktree.
- In-process tests added (pure cores):
  - `crates/ade-daemon/src/remote.rs`:
    `install_copies_only_to_the_same_platform_and_never_over_a_named_backend` and
    `uploads_write_atomically_under_the_remote_home`.
  - `crates/ade-core/src/contract/remote.rs`: the `RemoteHostInstall` wire shape.
  - `apps/cli/src/commands/remote-deadline.test.mjs`: the install deadline.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 110 | 10 | 30 | 0 |

## References

- phase2-remote-bootstrap.md, phase2-remote-transport.md, phase2-placement.md, audit-fix-remote.md, audit-minor-api-remote.md: the claims under test
- OpenSSH `ssh(1)` and `ssh_config(5)` behaviour for StrictHostKeyChecking, HostKeyAlias, UserKnownHostsFile and StreamLocalBind*, mirrored in the fake from the daemon's own `ssh_args` and the local OpenSSH 10.3 error text recorded in phase2-remote-bootstrap.md
- No code copied; no THIRD-PARTY-NOTICES entry needed.

## Open

- **Gap: remote-side revocation (F121, F122).** The remote backend does not issue or verify
  pairing tokens, so every pairing reply says `enforcement: local_profile`. After a revocation,
  anyone with SSH access to the host can still reach the remote daemon over the forward. The
  remote daemon cannot tell a forwarded connection from a local one, because both come from
  the same user on its Unix socket. So enforcement needs a separate token-checked endpoint, or
  a token in `hello`. That is a D13 design decision. The fixme spec is
  `pairing.spec.ts` › the remote daemon rejects a connection that presents a revoked pairing.
- **Gap: F126 cursor scoping.** The feed (`session.subscribe`) is not carried over
  `RemoteDaemonTransport`, so cross-host cursor confusion cannot be exercised.
- **Gap: F129 preview forward.** Only the capability report exists. Nothing spawns, tracks or
  tears down the `ssh -L 127.0.0.1:PORT:host:port` preview forward.
- **Pre-existing: producers do not call placement.** `workspace.open`, `conversation.create`
  and the others do not name a host. The specs place work through the remote transport and
  then `placement.record`, as phase2-placement.md describes.
- **Pre-existing: unsettled receipts.** A start or install whose receipt stays `dispatched`
  after a daemon crash is never reconciled automatically. Every retry reports "may still be
  running".
- **Shared files: none.** The generated contract files in `packages/contracts` were
  regenerated with `pnpm contract:generate`. On a merge conflict the coordinator regenerates
  them.
