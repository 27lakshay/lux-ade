# Audit fix: remote

Two confirmed defects from the post-merge audit, both fixed. Time spent: about 40 minutes.

## 1. The client SSH forward ignored the host key that remote.host.add pinned

- **Defect.** `sshForwardArgs` and `sshPreviewForwardArgs` checked only the user's
  known_hosts under the `ssh_target` name. A pinned host missing from that file
  always failed as `host_untrusted`. A different key stored there was accepted, so
  traffic could reach a host that fails the daemon's pin.
- **Fix.**
  - Contract: `RemoteHost` (`remote.host.list`, `remote.host.add`) now carries
    `host_public_key`, the pinned `type base64` line. The field is additive and
    public. `pnpm contract:generate` was run.
  - Client: `RemoteTarget.hostPublicKey` (`string | null`). The pure
    `hostTrustArgs` in `packages/client/src/remote-state.ts` gives a pinned target
    the same trust options as the daemon's `ssh_args`: `UserKnownHostsFile=<private
    file>`, `GlobalKnownHostsFile=/dev/null`, `KnownHostsCommand=none`,
    `HostKeyAlias=ade-remote-<id>`, `HostKeyAlgorithms`, `UpdateHostKeys=no`,
    `CheckHostIP=no` and `VerifyHostKeyDNS=no`. Both forward builders use it. A pinned
    target without a known_hosts path throws. An unreadable key makes the target
    `invalid_target`, so it never falls back to the user's known_hosts.
  - `RemoteDaemonTransport` writes the one-line known_hosts file (mode 0600) in its
    private 0700 directory and removes it on `dispose`. `RemoteConnections.get`
    treats a different pinned key as a conflict.
  - CLI: `placement preview` passes `registered.host_public_key`. `remote status` and
    `remote request` accept `--host-key`. Without it, a typed destination keeps the
    user's known_hosts, as before.
- **Tests.** In `packages/client/src/remote-state.test.mjs`, "a pinned target trusts
  only the key the daemon pinned, never the user known_hosts" reproduces the audit
  scenario. In `placement.test.mjs`, the preview-forward test covers a pinned target.

## 2. remote.host.remove kept execution_placements

- **Defect.** Removing a host left its placement rows. A host re-added under the
  same ID inherited them. `placement.resolve` and `placement.check` then sent work in
  that workspace to the new machine.
- **Fix.** The pure `removal_refusal` in `crates/ade-daemon/src/remote.rs` refuses
  while an active pairing or any recorded placement remains. It names
  `placement release` and says nothing was removed. The `remote.host.remove`
  handler counts placements in the same transaction, through
  `placement::placements_on_host`, before it deletes anything. No subprocess runs
  under the data lock.
- **Test.** `remote::tests::removal_refuses_while_placements_or_an_active_pairing_remain`.

## Checks

- `pnpm check:static` passed: rustfmt, the contract check, architecture, API parity,
  SDK build, typecheck, Fallow, JS build, JS pure tests, Clippy and the legacy Rust
  tests.
- No end-to-end work was done, following AGENTS.md.

References:
- crates/ade-daemon/src/remote.rs `ssh_args`, `HostKey::known_hosts_line` (the daemon's pin, mirrored)
- docs/proposed-architecture.md sections 4-6
