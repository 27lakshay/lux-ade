# phase1-services

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-6
Worker: ADE parallel build, Phase 1 typed domains, services
Requirements: none (D02 typed contracts for the services domain)

## Outcome

Every `service.*` and `listener.list` operation now has a typed request and response in `crates/ade-core/src/contract/services.rs`, plus the `service_changed` feed frame. The daemon handlers in `crates/ade-daemon/src/sessions/services.rs` and the proxy handlers in `crates/ade-daemon/src/bin/daemon/server.rs` decode the typed requests and build their replies from the typed responses. The CLI and Electron main check service replies with `decodeDailyUseResponse`.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `service.configure` | idempotent command | `ServiceConfigureRequest` | `ServiceReply` |
| `service.list` | query | `ServiceListRequest` | `ServiceList` |
| `service.inspect` | query | `ServiceInspectRequest` | `ServiceInspection` |
| `service.start` | effect command | `ServiceStartRequest` | `ServiceReply` |
| `service.stop` | effect command | `ServiceStopRequest` | `ServiceReply` |
| `service.remove` | effect command | `ServiceRemoveRequest` | `Ack` |
| `service.health.sample` | query | `ServiceHealthSampleRequest` | `ServiceHealthSample` |
| `service.proxy.ensure` | idempotent command | `ServiceProxyEnsureRequest` | `ServiceProxy` |
| `service.proxy.inspect` | query | `ServiceProxyInspectRequest` | `ServiceProxy` |
| `service.proxy.target` | query | `ServiceProxyTargetRequest` | `ServiceProxyTarget` |
| `service.proxy.remap` | effect command | `ServiceProxyRemapRequest` | `ServiceProxy` |
| `service.proxy.retire` | effect command | `ServiceProxyRetireRequest` | `ServiceProxyRetired` |
| `service.proxy.recovery.inspect` | query | `ServiceProxyRecoveryInspectRequest` | `ServiceProxyRecovery` |
| `service.proxy.recovery.retry` | effect command | `ServiceProxyRecoveryRetryRequest` | `ServiceProxy` |
| `service.proxy.recovery.reset` | effect command | `ServiceProxyRecoveryResetRequest` | `ServiceProxyRecoveryReset` |
| `listener.list` | query | `ListenerListRequest` | `ListenerInventory` |

Feed frame: `service_changed` (`ServiceChanged`).

Tier reasoning:

- `service.configure` returns the stored service unchanged when the config is the same, so a repeat converges.
- `service.proxy.ensure` reuses an existing route with the same target, so a repeat converges.
- `service.remove` is removal and retires the service terminal. The store treats a missing service as success, but the tier follows the removal rule.
- `service.proxy.remap`, `retire`, `recovery.retry` and `recovery.reset` are compare-and-set against reviewed state; a repeat fails instead of converging.
- `service.health.sample` and `service.inspect` with `health_check` send an HTTP GET to the service. They change only in-memory sample caches, so they are queries.
- `service.proxy.target` is called by the runtime proxy, not by clients.

## Receipts

No service operation had a request_id receipt, operation lookup or idempotency table. Nothing moved onto `receipts.rs`, and no service request carries `operation_id` yet. The effect commands are declared as such but have no receipt; that is later work.

## Wire shapes

Confirmed against the handlers, the runtime proxy (`crates/ade-runtime/src/bin/supervisor/service_proxy.rs`), `apps/cli/src/commands/services.ts`, `apps/desktop/src/main/services.ts` and `apps/desktop/src/renderer/src/services.tsx`. The round-trip tests encode the pre-typing JSON of each reply.

Kept as `serde_json::Value` because the shape is irregular or owned elsewhere:

- `metrics` in `service.list` states, `service.start` and `service_changed`: runtime terminal metrics.
- `logs` and `durable_logs` in `service.inspect`: the runtime terminal tail and `ade_runtime::service_logs::tail`.
- `health` and `health_monitor`: several state/basis combinations with optional fields.
- `ServiceConfigureRequest.config` is a `Value` in Rust with the `Config` schema, so malformed recipes keep serde's own messages. `ServiceInspectRequest.health_check` is a `Value` with a `HealthCheckRequest` schema, so `HealthCheck::parse` keeps its messages.

`ade_core::services::Config` is `#[schemars(inline)]`. Its serde defaults make the request and reply schemas differ, and the bundle panics on a shared definition that differs.

The daemon now decodes the runtime's proxy replies into the typed structs before forwarding them. A reply that does not match fails with `Runtime proxy reply failed its contract: ...`. Unknown extra fields from the runtime would be dropped.

## Behaviour changes on malformed requests only

- A field with the wrong JSON type now fails with `Invalid request: <serde message>`, as in the Phase 0 examples. Before, most read as `Missing ...`, and a non-integer `tail_bytes` read `Invalid tail limit`.
- The older wording is kept for absent fields: `Missing service revision`, `Missing service name`, `Missing port variable`, `Missing expected route ID`, `Missing expected service identity`, `Missing expected target port`, `Missing expected proxy port`, `Missing expected route identity`, `Missing expected route port`, `Missing expected registry SHA-256`, `Invalid connected proxy host`, and the remap and target mismatch messages.
- Field checks now run before the workspace-bound check in the proxy handlers, so a request that is both malformed and unbound reports the field.
- `service.proxy.target` requires `shell_pid` to be an integer; before, any JSON number passed.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-core/src/contract/services.rs` (`#[cfg(test)] mod tests`): tiers and frames, request and reply round trips against the generated schema, and three rejections the daemon also makes.
- E2E: not run, as the test policy requires.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 5 | 10 | 0 |

## References

- None from the reference repos. schemars 1.2.2 `inline` and `range` attributes were checked by compiling and reading the generated bundle.

## Open

- Shared file: `crates/ade-core/src/contract/tests.rs`. Its `every_operation_declares_a_tier_and_named_types` test listed every operation in the bundle, so adding any domain broke it. This slice scoped it to the `workspaces` and `conversations` domains; each domain now asserts its own tiers. Other workers may have changed the same test; keep one scoped version at merge.
- Clients use `decodeDailyUseResponse` and `DailyUseOperation` from `@ade/client`, which re-exports `@ade/contracts`. Neither `apps/cli` nor `apps/desktop` depends on `@ade/contracts` directly, and adding that dependency would touch shared package manifests and the lockfile.
- The renderer (`apps/desktop/src/renderer/src/services.tsx`) still casts replies to its own local types; it is outside this slice.
- Effect commands have no `operation_id` or receipt.
