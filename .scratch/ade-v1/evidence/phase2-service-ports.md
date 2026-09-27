# phase2-service-ports

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-9
Worker: Phase 2 workflow, slice service-ports
Requirements: F085, F086, F087, F088, F089 (advanced, not accepted); architecture audit finding in sections 5 and 11 ("service port probing is advisory")

## Outcome

A service's listener now counts as its own when its PID is in the run's process
tree (the direct process, a descendant through live parents, or a member of the
process group the live PTY session leader leads), checked with `proc_pidinfo`
and start times so a reused PID fails closed. A port held by any other process
is reported explicitly: readiness `port_conflict`, health `unhealthy` with basis
`port_taken_by_other_process`, and the stable URL refuses to forward. A service
whose tree listens only on an unassigned port (a lost bind that fell back, as
Vite does without `strictPort`) gets readiness `bound_unassigned_port` and health
`unhealthy` / `assigned_port_not_bound`. Peer wiring uses the same tree rule.

The pure verdicts live in `crates/ade-daemon/src/listeners.rs`:
`tree_membership`, `owning_root`, `port_observation`, `readiness_verdict` and
`health_gate`.

Inherited listening sockets are not handed over. Services are arbitrary
programs that bind the port named in their environment; the common dev servers
accept no passed descriptor, and portable-pty's spawn calls `setsid` and closes
every descriptor above stderr. The reason is recorded in the `listeners.rs`
module comment. An opt-in socket-activation convention (`LISTEN_FDS`) would be
the way to add it later.

## Operation tiers

No operation added. Changed behaviour of existing operations:

- `listener.list` (query): tree attribution instead of direct-PID attribution.
- `service.inspect` (query): new readiness state `bound_unassigned_port`, new
  readiness basis `process_tree_tcp_listener` (used only when a verified
  listener is a descendant; direct listeners keep `direct_process_tcp_listener`),
  explicit `unhealthy` health bases.
- `service.health.sample` (query): the same health gate.
- `service.proxy.target` (query): wires only rows attributed to this run and
  refuses any other holder on the port and family.
- `service.start` (effect command): peer resolution uses tree attribution.

The two enum values are additive; existing values are unchanged, so legacy
callers and E2E expectations for direct listeners still hold.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-daemon/src/listeners.rs` (13 tests: tree
  membership, owning root, port observation, readiness verdict, health gate);
  one round trip for the new enum values in `crates/ade-core/src/contract/services.rs`.
- A throwaway live test (removed before commit) confirmed `proc_pidinfo` returns
  parent, group and start time on this Mac and places a spawned child in its
  parent's tree.

Verified only statically: the wiring in `list_listeners`, `inspect_service`,
`resolve_peer_targets` and `proxy_target`.

Needs E2E later:

- `pnpm dev`-style wrapper whose node child binds: readiness `tcp_listening`
  with basis `process_tree_tcp_listener`, and the stable URL forwards.
- Another process takes the assigned port between `check_ports` and the bind:
  `port_conflict`, `unhealthy`, and the proxy refuses.
- Vite without `strictPort` falls back to another port: `bound_unassigned_port`.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 5 | 10 | 0 |

## References

- t3code @ evaluation snapshot, `apps/server/src/preview/PortScanner.test.ts`: studied (advisory scanning only; nothing copied).
- portable-pty 0.9.0 `src/unix.rs` (`setsid`, `close_random_fds`): studied to confirm the session-leader group rule and the descriptor limit.

## Open

- Residual race: a listener PID that exits after `lsof` and is reused by a
  descendant of the same run would be attributed to it. The start-time check
  cannot catch this because `lsof` gives no start time.
- A service that daemonizes with its own `setsid` and double fork leaves the
  tree and is reported as another process (fails closed).
- `process_info` is macOS-only, like `observe`; elsewhere only the direct
  process counts.
- No shared-file changes needed.
