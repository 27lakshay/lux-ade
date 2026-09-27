# phase2-placement

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-10
Worker: Phase 2 round D workflow, slice placement
Requirements: F126, F127 and F129 (advanced, not accepted); architecture sections 3 and 9

## Outcome

Workspaces, conversations, terminals and services now resolve to an explicit
execution host. The local host is the default only for a resource this daemon
holds in its own tables. A resource created on a remote host is recorded with
that host's registry ID, and its host never changes. A resource neither held
nor recorded is refused, never assumed local.

Placement of new work names its host. `placement.check` refuses a host that is
unregistered, unpaired, revoked, never started, failed or of unknown state. The
refusal names the chosen host and says nothing was placed; it never offers the
local host instead. On the client, `admitPlacement` also requires the remote
transport to be connected to that same host and profile.

Remote previews are capability-based. `previewCapability` in `@ade/client`
forwards only an http(s) URL on the remote host's own loopback address, and only
while its transport is connected. `sshPreviewForwardArgs` builds the
loopback-bound `ssh -L` for it. Remote device control reports `unsupported` and
names no local device instead.

No requirement is fully accepted. Each still needs the E2E rows in the 11-remote
spec.

### Rules the pure decisions enforce

- `local` is reserved. `remote.host.add` now refuses the host ID `local`, and the
  placement table has a `CHECK(host_id <> 'local')`.
- `ExecutionHost` is `{"kind":"local"}` or `{"kind":"remote","host_id":...}`.
  `Local` is a struct variant, so a stray `host_id` on a local host is a decode
  error rather than a silent local placement.
- Work inside a workspace runs on that workspace's host. A check or record
  whose workspace runs on another host, or on no known host, is refused.
- Readiness from the daemon's evidence:
  - Remote hosts need an active pairing and a `remote.host.start` result that
    reports `running` with a daemon identity. That result must be settled after
    the host's current registration.
  - A failed start gives `unavailable`. An unknown start gives `unknown`.
  - A running start gives `started`, never `ready`. The daemon cannot see the
    live link, so the client transport must still be connected.
- A record needs a registered host with an active pairing. A repeated record
  converges. A record for another host, or for a resource held here, is
  refused.
- A workspace record cannot be released while work inside it is still recorded.

## Operation tiers

| Operation | Tier | Why |
|---|---|---|
| `placement.hosts` | query | Reads the registry, pairings and start receipts |
| `placement.check` | query | Decides from evidence; places nothing |
| `placement.record` | idempotent command | The same record converges; a different host is refused |
| `placement.resolve` | query | |
| `placement.list` | query | |
| `placement.release` | idempotent command | Releasing an absent record converges; the remote host is untouched |

No effect command was added, so no receipts are written.

Storage: the `execution_placements` table is in the profile state database
(`sessions.sqlite`). It is created with `CREATE TABLE IF NOT EXISTS` on first
use. No numbered migration was added.

## Checks

- `pnpm check:static`: pass (449 legacy Rust tests run, 449 passed).
- In-process tests added:
  - `crates/ade-daemon/src/placement.rs`, 8 tests: remote readiness, refusal
    on unavailable or unregistered hosts, admission on ready hosts, workspace
    host consistency, recording never relocating, recording needing a paired
    host and a matching workspace, local-only-when-held resolution, and stored
    host IDs.
  - `crates/ade-core/src/contract/placement.rs`, 2 tests: wire shapes, and
    refusal of an implicit or malformed host.
  - `crates/ade-daemon/src/remote.rs`: one assertion that `local` is refused.
  - `packages/client/src/placement.test.mjs`, 7 tests: transport-aware
    admission, local placement without a transport, remote loopback forwarding
    and its refusals, device capability, and the forward's arguments.
- Manual smoke, not committed: a debug `ade-daemon` on a scratch profile, driven
  through `ade placement ...` and `ade remote ...`. These behaved as specified:
  - hosts, local and remote checks, and remote-host refusals before pairing,
    before start and after revocation
  - recording and repeating a record
  - refusal to record a held local workspace or terminal as remote
  - refusal of a terminal under the wrong workspace
  - local resolution of a workspace's primary terminal
  - refusal of the release of a workspace with recorded work inside
  - preview reports for local and remote hosts
  - refusal of `remote add local`
  The smoke found that a workspace's primary terminal lives in `terminal_id`,
  not `extra_terminals`; that bug was fixed.
- Verified only statically:
  - The `started` path: no remote daemon was ever started.
  - `placement preview` connecting through `RemoteDaemonTransport` to a real
    host.
  - The `ssh -L` preview forward against a real sshd.
  - Local held-state lookup for conversations and services.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 15 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/main/ssh/system-ssh-port-forward-provider.ts`, `src/main/ssh/ssh-port-forward.ts`, `ssh-port-forward-provider.ts` (MIT): pattern. The local end of a port forward binds 127.0.0.1, and the forward names a remote host and port. No code copied.
- `.scratch/parallel-build/research/08-reference-map.md` rows for Remote and SSH (Orca remote deploy, Herdr host/restart policy): consulted; not applicable to placement records.
- WHATWG URL `hostname` keeps IPv6 brackets. This was checked in the Node 24 runtime the tests use, not in web docs.
- No THIRD-PARTY-NOTICES entry needed.

## Open

- **Producers do not call placement yet.** `workspace.open`, `conversation.create`, `terminal.create` and `service.start` do not name a host. A remote resource is recorded by the caller after it creates the resource through the remote transport. The Electron main flow (`placement.check`, then `admitPlacement`, then the remote create, then `placement.record`) is not wired.
- **Crash between remote create and record.** If the client dies after the remote create, the resource exists on the remote host with no local record. Reconciling from the remote host's catalog is not built.
- **Readiness is evidence, not liveness.** `started` comes from the last settled start. A start still in flight, which has no result yet, is invisible to it, because the receipt payload is not stored.
- **Preview forwarding process.** Only the arguments and the capability decision exist. Spawning, tracking and tearing down the `ssh -L` preview forward, and choosing a free local port, are not built. The TS transport trusts the user's `known_hosts` rather than the daemon's pinned key. This is inherited from remote-transport.
- **Remote device access (F129).** It is reported `unsupported` everywhere. D12 still has to name a supported remote transport/platform combination before any remote device control exists.
- **Host removal.** `remote.host.remove` does not check for recorded placements. Records on a removed host still resolve to it, and checks against it are refused.
- **E2E later.**
  - F126: several hosts with independent reconnects.
  - F127: an explicit choice preserved through retries, and an incompatible placement rejected.
  - F129: a forwarded remote preview, and unavailable device access.
  - A renderer host badge.
- **Shared files.**
  - `crates/ade-daemon/src/sessions.rs`: `mod placement;` and one dispatch arm.
  - `crates/ade-daemon/src/lib.rs`: `pub mod placement;`.
  - `apps/cli/src/index.ts`: import, usage and registration entries.
  - `crates/ade-daemon/src/sessions/remote.rs`: `ensure_schema` is now `pub(super)`.
  - `crates/ade-daemon/src/remote.rs`: `validate_host_id` refuses `local`.
  - `packages/client/package.json`: the new test file is in its `test` script.
