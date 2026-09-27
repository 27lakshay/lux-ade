# E2E round 1: services

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-5
Worker: ADE parallel build, E2E round 1, services worker
Requirements: F085, F086, F087, F088, F089, F090 (07-terminals-services); R005 and R006 as they apply to services and scripts

## Outcome

Headless E2E now proves managed services, listeners, port claims, stable URLs,
peer wiring and workspace scripts against real daemons and runtimes. The suite
is `e2e/protocol/services/`: 38 tests pass and 1 is `test.fixme`. It found no
product bug in the services area, so no product code changed.

The register acceptance of F085, F086, F087, F088, F089 and F090 now passes as
E2E. Two caveats on wording, below, are for the coordinator to judge.

## Acceptance criteria

| Requirement | Acceptance (07 spec) | Spec | Result |
|---|---|---|---|
| F085 | Associate observable listeners with host/workspace where evidence allows | `listeners.spec.ts` "listener.list separates managed, discovered and unknown listeners"; `lifecycle.spec.ts` first test; `proxy.spec.ts` IPv6 test | pass |
| F085 | Distinguish discovered, managed and unknown ownership | `listeners.spec.ts` (managed row, foreign row with PID and `unknown` ownership, assignments `verified_managed`, `observed_other`, `unobserved`) | pass, see caveat 1 |
| F086 | Run a configured service; track readiness and logs | `lifecycle.spec.ts` "a configured HTTP service starts…" (readiness, live and durable logs, health probe, health monitor) | pass |
| F086 | Survive UI closure | `lifecycle.spec.ts` "survives a graceful / kill daemon restart" | pass |
| F086 | Verify shutdown before releasing managed claims | `lifecycle.spec.ts`; `faults.spec.ts` (crashed process, SIGTERM ignored, escaped listener); `listeners.spec.ts` (foreign listener keeps the claim quarantined); `recovery.spec.ts` | pass |
| F087 | Coordinate managed launches across profiles | `ports.spec.ts` "two profiles with the same assigned port launch one at a time"; "a profile that loses its daemon keeps its port claim…" | pass |
| F087 | Handle bind races | `listeners.spec.ts` "start is refused while a foreign process holds the assigned port", "a foreign process that wins the bind race…", "falls back to another port…" | pass |
| F087 | Claim a reservation only when ownership is verified | `ports.spec.ts` (claim is `dispatched` until the listener is verified, then `bound`); `listeners.spec.ts` race (never bound to a foreign listener) | pass |
| F088 | Route HTTP and WebSocket traffic to the correct host and service | `proxy.spec.ts` first test, IPv6 test, restart tests; `listeners.spec.ts` wrapper test | pass |
| F088 | Surface unavailable targets and explicit remapping | `proxy.spec.ts` "reports an unavailable target while stopped…", "a replaced service identity is never forwarded until an explicit, reviewed remap", "retired only when the reviewed route still matches", "blocked, not remapped, until retried", "corrupt stable URL registry…"; `listeners.spec.ts` race (proxy refuses a foreign holder); `recovery.spec.ts` (refuses an unverified orphan) | pass |
| F088 | Public aliases need a separate exposure policy | `proxy.spec.ts` asserts `scope: local_private` and loopback URLs; no public alias exists | pass (nothing exposed) |
| F089 | Resolve declared dependencies and endpoints | `peers.spec.ts` "receives its running peer endpoint…"; `proxy.spec.ts` IPv6 test (`http://[::1]:port`) | pass |
| F089 | Show effective nonsecret configuration | `peers.spec.ts` (`effective_peers`, `current_peer_endpoints`, `launch_peers`, `config.env`) | pass, see caveat 2 |
| F089 | Detect unavailable dependencies without silent substitution | `peers.spec.ts` (stopped peer refused, peer stop reported as `peer_error`, launch values kept, cycle, unknown service, missing port, foreign-held peer port) | pass |
| F090 | Discover and execute configured scripts with workspace identity | `scripts.spec.ts` "scripts are discovered from recipes and package.json…", "a recipe that escapes its workspace is refused…" | pass |
| F090 | Output and stop controls | `scripts.spec.ts` "a running script is stopped, retired only once stopped…", restart tests, CLI test | pass |
| F090 | No saved-command UI | `scripts.spec.ts` (an extra `program` field is ignored; only configured scripts run) | pass |

Fault cases covered:

- Restarts: graceful and killed daemon restarts with a running service, a
  running script and a live stable URL (`lifecycle`, `scripts`, `proxy`).
- Crashes: service process SIGKILL (`faults`); runtime SIGKILL with the service
  or script still running (`recovery`); runtime SIGKILL with the stable URL's
  port taken or its registry corrupt (`proxy`); daemon SIGKILL with a claim
  held for another profile (`ports`).
- Duplicate requests: concurrent and repeated starts, repeated and concurrent
  stops, repeated script stop, repeated retire, repeated remap (`lifecycle`,
  `faults`, `scripts`, `proxy`).
- Conflicts: cross-profile port claim, foreign listener before start, during
  the bind and on a peer port, stale remap and retire (`ports`, `listeners`,
  `peers`, `proxy`).
- Uncertain outcomes: start and stop whose reply was lost (`faults`); a
  quarantined recovery attempt that stop and retire refuse to settle until the
  old tree is observed gone (`recovery`).

Fixme:

- `faults.spec.ts` "service.start replays by operation ID and returns its
  receipt". Gap: `service.start` and `service.stop` are effect commands but
  take no `operation_id` and return no receipt (architecture section 4;
  phase1-services evidence). Retries converge on service state instead, which
  the lost-reply test proves.

Not covered:

- A restart-reconciled attempt classified `unknown` (no identity recorded
  before the runtime died) and its release through `runtime.recovery.release`.
  The classification depends on the two-second snapshot, so a deterministic
  spec needs a way to kill the runtime before the first snapshot.

Caveats:

1. `ListenerOwnership` has two values, `managed_service` and `unknown`. A
   discovered foreign listener is a row with its PID and `unknown` ownership;
   the spec's three words map onto that and the assignment observations.
2. Service `config.env` is shown verbatim. ADE has no secret marking for
   service environment, so "nonsecret" holds only if users keep secrets out of
   recipes.

## Product fixes

None. Every spec that ran passed against the existing services code.

## New fixture

`e2e/protocol/fixtures/services.ts` (new file, not re-exported from
`fixtures/index.ts`):

- a real Node HTTP and WebSocket server and a `pnpm dev`-style wrapper, with
  environment switches for a bind gate, bind fallback, SIGHUP and SIGTERM
  immunity, and the bind address;
- `startForeignListener`, a process outside ADE owned by the test's ledger;
- `httpGet`, `websocketMessage`, `rawReply` (the reply frame with `code` and
  `recovery`), `logText`, `waitForReadiness`, `configureService`;
- `serviceNameForPort`, which mirrors the port allocator so two profiles get
  the same assignment.

## Operation tiers

None added or changed.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/services`: 38 passed, 1 fixme.
- `pnpm check:static`: pass.
- In-process tests added: none.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 10 | 15 | 0 |

## References

None.

## Open

- Outside this area: the SDK folds error codes it does not list into
  `daemon` (`packages/client/src/request.ts`, `knownCodes`). A
  `host_resource_conflict` reply therefore reaches SDK and CLI callers as
  `code: 'daemon'` with no `recovery`. `ports.spec.ts` asserts the wire code
  through `rawReply` and only the message through the SDK and CLI.
- `recovery.spec.ts` waits for the daemon's attempt identity snapshot by
  reading `runtime_attempt_records` read-only from the profile database. No
  protocol operation exposes whether a run's identity is recorded.
- Port allocation still does not skip ports another profile has claimed
  (phase2-resource-claims). A clash is refused at start, as `ports.spec.ts`
  proves, not avoided at configure time.
