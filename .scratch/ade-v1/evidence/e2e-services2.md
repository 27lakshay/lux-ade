# E2E round 2: service gaps

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-7
Worker: ADE parallel build, E2E round 2, service-gaps worker
Requirements: F087, F088, F089, F090 (07-terminals-services)

## Outcome

Round 1 held back F087–F090 on claim timing, secret configuration and host
identity. This slice closes all three. The suite is `e2e/protocol/services2/`:
10 tests pass and none is `fixme`. The round 1 suite `e2e/protocol/services/`
still passes (38 passed, 1 fixme).

Together with round 1 (`e2e-services.md`), the full register acceptance of
F087, F088, F089 and F090 now passes as E2E. Remote routing is proved only as
far as the placement contract allows without a remote host; see Open.

## Acceptance criteria

This table lists only the criteria this round re-proves or newly proves. The
round 1 rows in `e2e-services.md` still stand.

| Requirement | Acceptance (07 spec) | Spec | Result |
|---|---|---|---|
| F087 | Claim a reservation only when ownership is verified | `claims.spec.ts` "a port claim stays dispatched until the listener is verified, then is bound to it": `dispatched` with no `listener_pid` through `service.inspect` and `listener.list` while the service has not bound; another profile sees the same `dispatched` claim and is refused; `bound` with the listening PID after the bind; released after a verified stop | pass |
| F087 | Verified ownership through the process tree | `claims.spec.ts` "a wrapper that launches the real server binds the claim to the child that listens" | pass |
| F087 | Handle bind races | `claims.spec.ts` "a claim is never bound to a foreign listener that won the bind race" | pass |
| F087 | Restarts | `claims.spec.ts` "a dispatched claim is kept as an unknown outcome…" (graceful and kill): quarantined `outcome_unknown`, never bound or released until a verified stop | pass |
| F088 | Route traffic to the correct host and service | `identity.spec.ts` "stable URLs route to the service of their own workspace on the host its placement names": two workspaces with the same service name; each route names `execution_host`, which matches `placement.resolve` for the service and the workspace; each URL reaches the process of its own workspace; survives a daemon kill | pass |
| F088 | No fallback to, or relocation from, the local host | `identity.spec.ts` "a remote host is refused through placement and never replaces the local route" | pass |
| F089 | Show effective nonsecret configuration | `secrets.spec.ts` "secret service values are redacted everywhere ADE shows them and reach only the process": `service.configure`, `service.start`, `service.list`, `service.inspect`, the CLI and the `service_changed` feed frame never carry the secret; the process receives it | pass |
| F089 | Secrets survive edits without leaking | `secrets.spec.ts` (redacted round trip converges or keeps the value; a daemon kill; rotation); "the redaction placeholder is never stored as a secret value" | pass |
| F090 | Execute configured scripts with host and workspace identity | `identity.spec.ts` "script runs carry their workspace and host identity and stay inside their workspace": `execution_host` on start, runs and inspect; the process gets `ADE_WORKSPACE_ID`, `ADE_WORKSPACE_ROOT`, `ADE_EXECUTION_HOST`, `ADE_SCRIPT_NAME`, `ADE_SCRIPT_RUN_ID`; the run resolves through `placement.resolve` as a local terminal of its workspace; another workspace cannot inspect or stop it; the CLI shows the identity; survives a graceful restart | pass |

Fault cases covered: graceful and kill daemon restarts (claims, secrets,
routes, script runs), a foreign bind race, a conflicting second profile,
duplicate configure requests (a redacted re-save converges without a new
revision), and conflicts in placement records.

## Product fixes

- **F089 secret configuration.** A service `Config` has a new
  `secret_env` list naming `env` entries whose values are secret. Every reply
  and the `service_changed` frame show those values as `[redacted]`
  (`Service::redacted`, applied in `ServiceReply::service`, `service.list`,
  `service.inspect` and the frame). A configure that sends `[redacted]` for a
  secret keeps the stored value; with no stored secret it is refused, so the
  placeholder is never stored. A secret name must be a configured variable.
  Pure-core test: `ade-core services::tests::secret_values_are_redacted_and_kept_only_from_a_stored_secret`.
- **F088 host identity in routing.** `ServiceProxy` has a required
  `execution_host`. The daemon adds it to the runtime's reply after resolving
  the workspace's placement (`Sessions::execution_host`). A route is ensured,
  inspected, retried or forwarded only for a workspace on the local host; a
  workspace recorded on a remote host is refused, never routed here. The
  contract test now refuses a proxy reply without its host.
- **F088/F090 identity in processes.** A service run also gets
  `ADE_WORKSPACE_ID` and `ADE_EXECUTION_HOST`. A script run gets
  `ADE_WORKSPACE_ID`, `ADE_WORKSPACE_ROOT`, `ADE_EXECUTION_HOST`,
  `ADE_SCRIPT_NAME` and `ADE_SCRIPT_RUN_ID`. `ScriptRun`, `ScriptRuns` and
  `ScriptInspection` carry `execution_host`.
- `ADE_EXECUTION_HOST` is `local`, or a remote host's registry ID
  (`placement::env_value`).

## New fixture

`e2e/protocol/fixtures/env-echo.ts` (new file): an HTTP server that reports
its `ADE_*` variables and named variables, and a one-shot program that prints
its `ADE_*` variables. `printedEnv` parses the printed line.

## Operation tiers

None added or changed. `service.configure` stays an idempotent command.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/services2`: 10 passed.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/services e2e/protocol/services2`: 48 passed, 1 skipped (the round 1 fixme).
- `e2e/protocol/recovery/descendants.spec.ts` and `e2e/protocol/orchestration/parity.spec.ts`, which use services and scripts: 8 passed, 1 skipped.
- `pnpm check:static`: pass (733 Rust tests).
- No `ade-daemon` or `ade-runtime` from this worktree is left running.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 50 | 5 | 15 | 0 |

## Open

- **Remote routing is not exercised against a remote host.** No remote host
  can be started headlessly. The specs prove the local host through the
  placement fields and prove refusal of a remote host through
  `placement.check` and `placement.record`. Routing a stable URL to a service
  on a remote host goes through `previewCapability` and the SSH forward
  (phase2-placement) and needs the 11-remote E2E.
- **An adopted run's dispatched claim stays quarantined.** After any daemon
  restart, a claim the old incarnation left `dispatched` is quarantined as
  `outcome_unknown` and is not re-bound when the adopted run's listener is
  verified. Another profile stays refused until the run is stopped. This is
  conservative and meets the criterion. Re-owning the claim on verification
  would be a product change for the coordinator to decide.
- **Secrets are stored in plain text** in the profile database, as all
  service configuration is. Redaction covers what ADE shows; it is not
  encryption at rest.
- A secret's value can still appear in the service's own output if the
  program prints it.
