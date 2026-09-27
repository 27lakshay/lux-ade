# phase2-remote-bootstrap

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-7
Worker: Phase 2 round C workflow, slice remote-bootstrap
Requirements: F124 and F122, controlling-profile side (advanced, not accepted); decision D13; architecture section 9

## Outcome

The profile now keeps a registry of remote hosts. Each host has an SSH target and
a pinned host key. It can carry one active pairing, which stores a token
reference and never the token. ADE bootstraps a host through the system `ssh`
binary:

1. It verifies the pinned key.
2. It reports exactly what the remote ADE backend lacks.
3. It starts the remote profile daemon, or attaches to the one already running.

It installs nothing. Revoking a pairing makes this profile refuse to start or
attach the host. Work already running on the host is left alone.

Storage lives in the profile state database (`sessions.sqlite`). The tables
`remote_hosts` and `remote_pairings` are created on first use with
`CREATE TABLE IF NOT EXISTS`. A partial unique index allows one active pairing
per host. No numbered migration was added.

### Host identity (D13)

- **No trust on first use.** `remote.host.add` requires `expected_fingerprint`
  (`SHA256:...`, obtained out of band with `ssh-keygen -lf` on the host). The
  daemon reads the host's keys with `ssh -G` and `ssh-keyscan`, or takes a
  supplied `host_public_key` line. It pins only the key whose fingerprint
  matches. On a mismatch it lists the fingerprints the host presented, records
  nothing, and states that nothing was recorded.
- **A target behind a proxy** (ProxyJump or ProxyCommand in `ssh -G`) is refused
  unless the caller passes `host_public_key`, because `ssh-keyscan` cannot
  follow a proxy.
- **Every later `ssh` run uses only the pinned key.** It gets a one-line
  known-hosts file (mode 0600 in a 0700 temp directory, removed afterwards),
  keyed by `HostKeyAlias=ade-remote-<host_id>`. The options are
  `StrictHostKeyChecking=yes`, `GlobalKnownHostsFile=/dev/null`,
  `KnownHostsCommand=none`, `HostKeyAlgorithms` for the pinned type (RSA uses
  SHA-2 only), `UpdateHostKeys=no` and `CheckHostIP=no`.
- **No shared control master.** `ControlMaster=no` and `ControlPath=none` stop an
  existing multiplexed connection from bypassing the key check.
- **No prompts and no forwarding.** `BatchMode=yes` and
  `SSH_ASKPASS_REQUIRE=never` prevent prompts. `ForwardAgent=no`,
  `ForwardX11=no`, `ClearAllForwardings=yes` and `PermitLocalCommand=no` keep
  credentials on each host. The user's SSH config still supplies the user,
  identity and proxy settings; command-line options take precedence over it.

### Backend compatibility

The probe pipes a read-only script to the remote `/bin/sh -s`. The script
reports `uname`, locates `ade-control` (the configured `backend_path`, or
`command -v`), checks that it is executable, and runs the new
`ade-control version`. That subcommand reports the application and runtime
protocols, and whether `ade-daemon` and `ade-runtime` are executable beside it.
The pure `compatibility` decision names each gap, for example:

- "ade-control is not on the remote non-interactive PATH; install it or set backend_path"
- "an executable ade-daemon beside /opt/ade/ade-control"
- "`/c version`; the remote backend predates remote bootstrap"
- "application protocol X, expected ade-application-v1"
- an unsupported operating system

### Start or attach

`remote.host.start` is an effect command with a receipt in `sessions.sqlite`:

1. It admits the receipt. It requires a known host and an active pairing, and
   moves the receipt to `dispatched` before any `ssh` runs.
2. It probes the host. An incompatible backend settles as `failed` and nothing
   is started.
3. It runs `exec '<verified ade-control>' profiles start ['<remote profile>']`
   remotely. That command starts the daemon or attaches to the running one.

The pure `classify_start` returns one of three outcomes:

- `running`: only when the reply carries a daemon identity with matching
  protocols.
- `failed`: when nothing can have started. That covers a host key rejection,
  an `ssh` connection failure before the session, exit 127, and the
  `ade-control` refusals it makes before launching anything (no selected
  profile, unknown profile, launch lock held, incompatible running daemon).
  A running daemon with the wrong protocols is also `failed`, and is left
  running.
- `unknown`: a timeout, a signal, an unreadable reply, a mid-session `ssh`
  drop, or any other `ade-control` error.

`unknown` is stored with receipt status `unknown`. A replay returns the stored
reply. A receipt that never stored a result (the daemon crashed mid-attempt) is
not run again; the reply is `unknown` and says to probe and use a new operation
ID. The CLI exits with `outcome_unknown` or `not_applied` for those outcomes.

## Operation tiers

| Operation | Tier | Why |
|---|---|---|
| `remote.host.list` | query | |
| `remote.host.add` | idempotent command | A repeat with the same definition returns the stored host; a different definition is refused. Only an exact fingerprint match is pinned. |
| `remote.host.remove` | idempotent command | Refused while a pairing is active; removing an absent host converges. The remote host is untouched. |
| `remote.host.probe` | query | Connects with the pinned key and runs a read-only script; changes nothing on either host. |
| `remote.host.pair` | idempotent command | A repeat with the same token reference returns the active pairing; a different reference is refused until the active one is revoked. |
| `remote.host.revoke` | idempotent command | Revoked is final; a repeat converges. |
| `remote.host.start` | effect command | Receipt-backed; never replayed blindly. |

## Checks

- `pnpm check:static`: pass. This covers rustfmt, the contract check,
  architecture, the SDK build, typecheck, Fallow, the JS build, the JS pure
  tests, Clippy and the legacy Rust tests (348 run, 348 passed).
- In-process tests added:
  - `crates/ade-daemon/src/remote.rs`: 13 tests. They cover OpenSSH fingerprints
    (checked against `ssh-keygen -lf` output), refusal of malformed and
    unsupported keys, fingerprint normalization, pinned-key selection, keyscan
    parsing, the pinning `ssh` arguments, identifier and token-reference
    validation, `ssh -G` proxy detection, script quoting, compatibility and gap
    naming, and start-outcome classification.
  - `crates/ade-core/src/contract/remote.rs`: 2 tests. They cover the wire
    shapes, and the refusal of a raw token in `token_reference`.
- Manual check, not committed: a user-space `sshd` on 127.0.0.1:2299 with
  OpenSSH 10.3. The full option set, including `KnownHostsCommand=none` and
  `HostKeyAlias` on a non-default port, connected and ran a probe script
  against the right key. It failed with exit 255 and "Host key verification
  failed" against a wrong key, and `host_key_rejected` recognizes that output.
  `ade-control version` was run locally.
- Verified only statically: the daemon handlers (SQLite storage, transactions,
  receipt flow, the lock released around `ssh`, the timeout and kill path),
  `obtain_key` running `ssh -G` and `ssh-keyscan`, and the CLI `remote` area.
  No daemon served these operations over its socket.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 60 | 5 | 15 | 0 |

## References

- Herdr @ ade-evaluation-2026-09-24, `herdr/src/remote/attach.rs` (Apache-2.0): pattern. Its `ssh_error_requires_authentication` separates host-key failures from authentication failures, and it uses `StrictHostKeyChecking=yes` and `SSH_ASKPASS_REQUIRE=never`. No code was copied.
- Herdr, `herdr/src/remote/host.rs` (Apache-2.0): studied. It checks the protocol generation before attaching and refuses to replace an incompatible server silently.
- t3code, `apps/server/src/auth/PairingGrantStore.ts` (MIT): studied. Pairing grants and revocation, where revoked is final. Its grant expiry and consumption are not modelled.
- Orca `orcad-remote-deploy` tests: not consulted. This slice installs nothing.
- OpenSSH manual pages (`ssh_config(5)`: HostKeyAlias, KnownHostsCommand, StrictHostKeyChecking, ControlPath) were checked against the local OpenSSH 10.3 behaviour instead of web docs.

## Open

- **The remote side of pairing.** The remote backend does not issue or check
  pairing tokens yet, so revocation is enforced only by this profile
  (`enforcement: "local_profile"` in every pairing reply). Acceptance needs a
  remote grant store, token presentation on connect, and rejection of revoked
  tokens by the remote daemon (F121/F122). The token reference is stored and
  never read.
- **Transport.** `remote.host.start` returns the remote daemon's socket and
  identity. Bridging the SDK to that socket over SSH (a stdio bridge or socket
  forward), reconnecting, and marking a lost link unknown (11-S08) are not
  built.
- **Reconciliation.** An `unknown` start has no automatic reconciliation. It
  could probe the remote daemon's `hello` and settle the receipt.
- **Explicit installation.** Installing artifacts (F124 "install compatible
  declared artifacts") is not built. Only the gaps are reported.
- **Key rotation.** There is no rekey operation. The user removes the host
  (after revoking) and adds it again with the new fingerprint.
- **Placement and multiple hosts (F126/F127).** Resource labelling by host and
  explicit placement are not built.
- **Remote profile creation.** A host with no selected remote profile fails with
  "No profile is selected"; ADE does not create one.
- **E2E later.** F124 needs E2E evidence against a real `sshd` fixture: pin,
  probe, start, reconnect, and a refused changed key. F122 needs pair, revoke
  and a refused start.
- **Shared files.** `crates/ade-daemon/src/sessions.rs` gained `mod remote;` and
  one dispatch arm. `crates/ade-daemon/src/lib.rs` gained `pub mod remote;`.
  `apps/cli/src/index.ts` gained an import, a usage entry and a command-area
  entry. `crates/ade-daemon/src/bin/control/main.rs` gained the `version`
  subcommand, which reads only.
