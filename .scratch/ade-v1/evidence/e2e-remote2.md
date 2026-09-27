# E2E round 3: remote-2

Status: returned
Type: slice evidence
Branch: claude/wf_317b0f50-41b-8
Worker: ADE parallel build, E2E round 3, remote-2 slice
Requirements: F121, F122, F126, F129 (11-remote); R017 (13-reliability); decision D13

## Outcome

Seven headless specs in `e2e/protocol/remote2/` drive a real local profile daemon and real remote
profile daemons and runtimes, started by `ade-control` over the fake-ssh fixture, through the SDK,
the CLI and the raw protocol. They exposed three product gaps that round 2 left open. All three are
now fixed:

- The execution host did not enforce pairing or revocation.
- No feed was carried over the remote transport.
- No preview forward existed.

All seven specs pass. The round-2 `test.fixme` in `remote/pairing.spec.ts` now passes as a
real test.

Register acceptance now passes headlessly for **F121, F122, F126, F129 and R017**. F126 is
proven by this slice's `hosts.spec.ts` together with round 2's `remote/placement.spec.ts`.

## Acceptance criteria

| Criterion | Spec | Result |
|---|---|---|
| F121 authenticated explicit endpoint: a start returns the host's paired endpoint, an owner-only Unix socket beside the owner socket; the remote daemon and runtime open no TCP listener; the client reaches it only through the pinned, strict, `StreamLocalBindMask=0177` forward | `remote2/revocation.spec.ts` › a start grants the pairing on an authenticated paired endpoint … | pass |
| F121 no unauthenticated listener: the endpoint refuses a hello without a pairing, any other first request, an unknown pairing and a wrong token (`unauthenticated`); the SDK transport stops with `unauthorized` | same | pass |
| F121 identity: the paired hello is the started daemon's pid and boot; the transport pins the runtime | same; `revocation.spec.ts` › the host keeps its grants across a daemon crash … | pass |
| F121 link failure observed: loss reports unknown and never reaches another endpoint | `remote2/revocation.spec.ts` › a revocation the host cannot receive …; `remote2/hosts.spec.ts`; `remote2/stability.spec.ts` | pass |
| F122 explicit trust: start grants the pairing on the host by the token's SHA-256; the grant file is owner-only and never holds the token | `revocation.spec.ts` › a start grants the pairing … | pass |
| F122 revoke rejects subsequent operations: the open feed is closed and stays closed; the next request is refused `pairing_revoked`, `not_sent`; the transport stops for good | same | pass |
| F122 revoke rejects reconnections: a new SDK connection, a raw hello and `ade remote status --pairing` are refused `pairing_revoked` | same; `remote/pairing.spec.ts` › the remote daemon rejects a connection that presents a revoked pairing (was fixme) | pass |
| F122 remote work is not removed: the same daemon keeps running the held turn with one `turn/start`; pairing again is a new pairing on the same daemon; the old pairing stays refused | `revocation.spec.ts` › a start grants the pairing … | pass |
| F122 uncertain outcome: a revocation while the link is down replies `enforcement: local_profile` with a retry detail; this profile already refuses start and placement; the host has not recorded it; revoking again after the link returns is confirmed `remote_daemon`, and the client's next hello is refused | `revocation.spec.ts` › a revocation the host cannot receive … | pass |
| F122 duplicate requests: revoking again converges; a repeated start grants the same pairing once | `revocation.spec.ts` (tests 1 and 3) | pass |
| F122 crash: grants survive a remote daemon SIGKILL (the endpoint reopens from the grant file and the client reconnects to the same runtime); a revocation survives one; the host refuses to grant a revoked pairing again, even with its own token | `revocation.spec.ts` › the host keeps its grants across a daemon crash … | pass |
| F126 two hosts at once: separate pairings, paired endpoints, transports and feeds | `remote2/hosts.spec.ts` | pass |
| F126 no cross-host cursor confusion: each feed's frames carry only its own daemon's boot ID; one host's frame applied to the other's projection forces a resnapshot; one host's restart moves only its own cursor epoch | same | pass |
| F126 no account confusion: each turn runs with its own host's provider; the local provider is never called | same | pass |
| F126 independent reconnect: alpha's link loss leaves beta's connection, feed and cursor advancing; alpha returns to its own boot and catalog; revoking alpha leaves beta's pairing, grant and feed untouched | same; round 2 `remote/placement.spec.ts` › several hosts are labelled apart … | pass |
| F126 register several hosts and label their resources unambiguously | round 2 `remote/placement.spec.ts` | pass (round 2) |
| F129 explicitly selected, reachable preview: a service the remote daemon runs on alpha is served at a local loopback URL through `ssh -L 127.0.0.1:P:127.0.0.1:PORT` to alpha, pinned to alpha's key | `remote2/previews.spec.ts` › a remote service is previewed … | pass |
| F129 target identity preserved: beta's transport cannot preview alpha's service; a URL naming another machine is not forwarded; neither spawns anything | same | pass |
| F129 unavailable features distinguished: remote device control is `unsupported` and not redirected; an unreachable or revoked host refuses a preview unsent | `previews.spec.ts` (both tests) | pass |
| F129 link drop: the preview forward ends, its local URL stops answering, nothing reopens it elsewhere; after reconnect it is reopened explicitly on the same host | `previews.spec.ts` › a preview whose link drops … | pass |
| R017 disconnect with local focus moved: remote commands fail unsent; the local daemon refuses the remote conversation; placement for the remote workspace on this Mac is refused naming alpha; placement records still name alpha; device control is not redirected; the local catalog and provider hold nothing remote | `remote2/stability.spec.ts` | pass |
| R017 reconcile against the original identity: reconnect pins the same runtime and boot; retrying the lost send with its request ID leaves one prompt and one turn | same | pass |
| R017 revoke with local focus moved: commands fail `pairing_revoked` against alpha's pin; placement is refused for alpha and for this Mac; the remote turn keeps running on alpha | same | pass |

## Product fixes

### 1. The host enforces pairing and revocation (F121, F122, D13)

- **Gap:** The remote backend never saw a pairing, so `enforcement` was always `local_profile`. A
  revoked client could still reach the remote daemon.
- **Fix:** A new pure core, `crates/ade-daemon/src/remote_access.rs`, owns the grant file
  `access-grants.json` in the remote profile's runtime home. Each grant holds a pairing ID and
  the SHA-256 of its token; it never holds the token. The core decides four things:
  - `grant`: a repeat grant converges, a revoked pairing is final, and an active pairing keeps
    its token.
  - `revoke`: a repeat revoke converges, and an unknown pairing is recorded as revoked.
  - `admit`: the check for each hello, compared in constant time.
  - `paired_socket`: `x.sock` serves `x.paired.sock`.
- **`ade-control`** changes:
  - `profiles start [ID] --grant PAIRING:SHA256` writes the grant under a lock before it starts
    or attaches. It then waits for the endpoint and returns `access.endpoint`.
  - New: `profiles access-revoke PAIRING [ID]` and `profiles access-list [ID]`. The list never
    prints digests.
- **Daemon** (`server/paired.rs`): once its grant file holds any grant, the daemon opens the
  paired endpoint.
  - The endpoint is owner-only and peer-uid checked, like the owner socket.
  - The first line must be a `hello` that presents `pairing_id` and `pairing_token`.
  - Every hello reads the grant file, so a revocation refuses new connections at once. The
    refusal is an error frame, `pairing_revoked` or `unauthenticated`.
  - A 100 ms watcher closes the open connections of a revoked pairing.
  - The owner socket is unchanged. It stays the host user's own; SSH login as that user remains
    full authority over the host.
- **Local daemon** changes:
  - `remote.host.start` resolves the pairing's token reference: an environment variable, or the
    Keychain through `security`. A start whose token cannot be resolved fails, and nothing is
    started. The start then sends only the digest through `--grant`.
  - `remote.host.revoke` revokes locally first, then records the revocation on the host over
    the pinned ssh (45 s deadline) without the data lock. The reply's `enforcement` is
    `remote_daemon` once the host confirms. Otherwise it is `local_profile`, and a new optional
    `detail` says to revoke again.
- **Contracts:**
  - `HelloRequest` gains optional `pairing_id` and `pairing_token`.
  - `RemoteDaemon` gains optional `paired_socket`.
  - `RemotePairingReply` gains optional `detail`.
  - Generated files were regenerated.
- **SDK:**
  - `RemoteTarget.pairing` is presented in every hello.
  - `RemoteFailure` adds `pairing_revoked` and `unauthorized`. A new pure `refused` event stops
    the transport with no retry and keeps the pin.
  - `pairingRefusal` classifies a refusal.
  - `waitUntilConnected` rejects with `pairing_revoked` or `unauthenticated`.
  - `AdeClient` takes a pairing and stops for good when its hello is refused.
- **CLI:**
  - `ade remote status|request` take `--pairing ID --token-env NAME`. The token is never
    accepted on the command line.
  - `remote revoke` waits out the host deadline (75 s).

### 2. A feed over the remote transport (F126)

`RemoteDaemonTransport.openFeed()` returns an `AdeClient` bound to the transport's private
forwarded socket, presenting its pairing. The feed can reconnect only through that forward.
`dispose()` stops it.

### 3. The preview forward (F129)

`RemoteDaemonTransport.openPreview(entry, url)` works in this order:

1. It admits only what `previewCapability` reports available now.
2. It picks a free loopback port and spawns `sshPreviewForwardArgs`, which is pinned to the
   transport's known_hosts.
3. It waits until the port accepts connections, then returns a `RemotePreview`: `localUrl`,
   `closed` with its reason, and `close()`.

A preview that ends stays closed and is never reopened elsewhere. `dispose()` closes all previews.

## Operation tiers

| Operation | Tier |
|---|---|
| `hello` | unchanged; optional `pairing_id`, `pairing_token` (checked only on a paired endpoint) |
| `remote.host.start` | effect command, unchanged; now grants the pairing on the host; `daemon.paired_socket` added |
| `remote.host.revoke` | idempotent command, unchanged tier; now also records the revocation on the host; `detail` added |

No operation was added.

## Fixtures

- `e2e/protocol/fixtures/fake-ssh.mjs` now supports loopback TCP forwards,
  `-L 127.0.0.1:PORT:127.0.0.1|[::1]:HOSTPORT`. This is additive.
- `e2e/protocol/fixtures/remote-hosts.ts`: `RemoteLab` has a random `pairingToken`, and each
  lab profile gets it in `ADE_E2E_PAIRING_TOKEN` and `ADE_DEVBOX_TOKEN`. The new export
  `pairingTokenEnv` names the first.
- `e2e/protocol/remote/steps.ts`: `addAndPair` pairs with `ADE_E2E_PAIRING_TOKEN`. Starts need a
  resolvable token now; the variable used to be unset.
- `e2e/protocol/remote2/steps.ts` is new: `pairedTarget`, `pairedLink`, `hostGrants`,
  `heldRemoteTurn`, `remoteTurns`, `hostEntry` and `clientSync`.

## Checks

- `pnpm check:static`: pass. The run covered rustfmt, the contract check, architecture, API
  parity, the SDK build, typecheck, Fallow, the JS build, the JS pure tests, Clippy and the
  legacy Rust tests.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/remote2 e2e/protocol/remote`:
  24 passed, 1 skipped. The skip was the old fixme; it was converted afterwards and passed on
  its own run (`remote/pairing.spec.ts`: 4 passed).
- `pgrep` found no `ade-daemon` or `ade-runtime` from this worktree or its scratch hosts
  afterwards.
- In-process tests added (pure cores):
  - `crates/ade-daemon/src/remote_access.rs`: grant, revoke and admit decisions; file format;
    paired socket path.
  - `crates/ade-daemon/src/remote.rs`: the start script with a grant, the revoke script.
  - `packages/client/src/remote-state.test.mjs`: the `refused` transition, `pairingRefusal` and
    pairing validation.
  - `apps/cli/src/commands/remote-deadline.test.mjs`: the revoke deadline.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 150 | 10 | 35 | 0 |

## References

- e2e-remote.md, phase2-remote-transport.md, phase2-placement.md: the round-2 claims and gaps
  under test.
- 11-remote spec and 13-reliability R017 acceptance; decision D13.
- OpenSSH `ssh(1)` `-L [bind_address:]port:host:hostport` behaviour, mirrored in the fake.
- No code copied; no THIRD-PARTY-NOTICES entry needed.

## Open

- **Interpretation to confirm (D13 / F121).** "Direct LAN/VPN connectivity" is met by the
  explicit SSH path to a LAN/VPN address plus the paired endpoint, with no relay. No TCP/TLS
  listener was added, because the spec forbids an unauthenticated listener and D13 names SSH
  paths. If the coordinator wants a raw TCP+TLS transport as well, F121 needs a new slice.
- **Host-user authority.** Pairing is enforced on the paired endpoint. A person who can log in
  over SSH as the host user can still use the owner socket or `ade-control` directly. That is
  the same authority as a shell on the host, and the code says so.
- **A revocation the host has not received** stays pending until `remote.host.revoke` runs
  again. Nothing retries it automatically. Until then an existing client can still reconnect to
  the host, although this profile refuses the pairing.
- **Idle transports** learn of a revocation on their next hello, a request or a reconnect. There
  is no heartbeat. Feeds learn at once, because the host closes them.
- **Shared fixture edits** (`remote-hosts.ts`, `fake-ssh.mjs`, `remote/steps.ts`,
  `remote/pairing.spec.ts`) are small and additive. Another remote worker that pairs a host
  with its own token variable must set that variable in the lab profile, or use `addAndPair`.
- **Shared files: none edited.** The generated contract files were regenerated with
  `pnpm contract:generate`.
