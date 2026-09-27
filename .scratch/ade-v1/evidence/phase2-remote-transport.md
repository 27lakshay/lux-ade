# remote-transport

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-8
Worker: Phase 2 round C, remote-transport
Requirements: F121 (client side, SSH-forwarded transport), F125 (client side, disconnect reports unknown with no local fallback), 11-S08 (partial: no blind replay after link loss)

## Outcome

`@ade/client/remote` adds `RemoteDaemonTransport`, which reaches a remote profile daemon through `ssh -N -L local_socket:remote_socket` and uses the same hello handshake, protocol checks and command semantics as a local socket. Connection state is keyed by host and profile. Link loss reports `unknown`, refuses requests unsent, and reconnects only to the same target. The first handshake pins the remote profile runtime (`runtime_socket`), and a reconnect that reaches a different runtime fails closed. The CLI gains `ade remote status` and `ade remote request`. No requirement is fully accepted; F121 and F125 still need the E2E evidence the spec lists.

## Operation tiers

No daemon operations were added or changed. `ade remote request` forwards any existing operation with its declared tier; the transport never retries a request, so an effect command with a lost reply stays `delivery: unknown` for the caller to reconcile with its own operation ID.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `packages/client/src/remote-state.test.mjs` (11 tests: pinning, unknown on link loss, refusal while unknown, identity mismatch, host-key and auth failures stop retrying, incompatible hello, stale events after stop, backoff, target validation against ssh option injection, ssh arguments, key scoping)
- Manual smoke, not committed: a fake `ssh` that forwards the Unix socket plus a fake hello daemon exercised connect, lost reply (`unavailable`/`unknown`), refusal while unknown, reconnect to the same profile, and `identity_mismatch` on a different runtime. Real `ssh` against an unresolvable host exited 255 and the CLI reported `timeout` with `delivery: not_sent`.

Verified only statically: behaviour against a real sshd and a real remote ADE daemon, ssh `StreamLocalBindUnlink`/`StreamLocalBindMask` behaviour, SIGTERM/SIGKILL teardown of the forward.

Needs E2E or UI later: F121/F125 acceptance rows (authenticated endpoint, revocation, remote workspace flow, disconnect during a turn for 11-S08), Electron main wiring of `RemoteConnections`, a renderer host badge for `unknown`.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 5 | 5 | 0 |

## References

- orca @ ade-evaluation-2026-09-24, `src/main/ssh/system-ssh-forward-process.ts`, pattern (ExitOnForwardFailure, `--` before destination, SIGTERM then SIGKILL teardown, stderr capture)
- herdr @ ade-evaluation-2026-09-24, `src/remote/restart_policy.rs`, studied (pure restart decision beside its tests)
- No code copied; no THIRD-PARTY-NOTICES entry needed.

## Open

- Hello carries no profile ID or host identity. The pin uses `runtime_socket`, which is a path inside the remote profile directory. The coordinator should consider adding `profile_id` (and a stable host ID) to `DaemonHello` in `crates/ade-core/src/contract/daemon.rs`; the transport would then pin on it.
- The feed (`session.subscribe`) is not yet carried over the remote transport; `AdeClient` would need an `unknown` status and a remote endpoint source.
- Pairing and revocation (F122), SSH bootstrap and artifact install (F124), and persisting remote host registrations are not in this slice.
- `ade remote` ignores `--socket`, `--profile` and `ADE_SOCKET` rather than rejecting them; it never uses them.
- The CLI always runs `ssh` from PATH; there is no override for a specific binary.
