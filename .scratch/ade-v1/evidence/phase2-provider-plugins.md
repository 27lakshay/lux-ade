# Provider plugins

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-1
Worker: Phase 2 round E, provider-plugins
Requirements: F023 (advanced, not accepted). Also touches F021 and F024: bundled providers and generic adapters now register through the same interface.

## Outcome

`ade-runtime` has one provider interface, `ProviderEntry`, and one registry. Claude Code, Codex, Oh My Pi, OpenCode, the generic adapters and plugin provider workers all register through `Registry::register`. `provider::spawn`, `capabilities::records` and `capabilities::installation` resolve bundled providers through that registry, and each launch runs the same adapter code as before.

A plugin whose manifest declares `entry_points.provider` becomes a pinned `ProviderWorker`: a Node process speaking JSON-RPC 2.0 over stdio, specified in `docs/provider-worker-protocol.md`. A run carries its worker pin in `agent_runtime::Spec.worker`, so the run keeps the artifact that started it. `provider.registrations` and `ade provider registrations` report every registration and its origin.

F023 is not accepted. The daemon cannot yet create a conversation on a `plugin:` provider; see Open.

## Operation tiers

- `provider.registrations`: query. It replays the bundled, adapter and plugin registrations through the registry and starts no worker.

No effect commands were added. `agent_runtime::Spec` gained an optional `worker` field that is omitted when absent, so the wire shape for existing providers is unchanged.

## Pure decisions

- `crates/ade-runtime/src/provider_registry.rs`
  - `namespace_problem` gives each origin its own ID namespace. Bundled providers use bare names, adapters use `adapter:<id>` and plugins use `plugin:<plugin id>`.
  - `decide` lets only the owner of an ID replace it, and only with a newer activation or revision.
  - `may_unregister` ensures a late cleanup from an older activation cannot remove a newer registration.
  - `lease` starts a new session on the current artifact. It keeps an existing session on the artifact it leased. When that artifact is gone, it refuses and does not move the session.
  - `retirable` allows an artifact to be retired only when no active lease holds it.
  - `compose` reports each registration and each refusal.
- `crates/ade-runtime/src/provider_worker.rs`
  - `check_launch` confines the entry to the pinned artifact.
  - `check_handshake` checks the protocol version and ignores unknown capabilities. It requires the permission modes to start with `default`.
  - `check_history` requires every history item to keep a unique native ID. Items with malformed fields are refused.

## Checks

- `pnpm check:static`: passed on the final tree (rustfmt, contract check, architecture, SDK build, typecheck, Fallow, JS build, JS pure tests, Clippy, and 593 legacy Rust tests).
- In-process tests added:
  - `crates/ade-runtime/src/provider_registry.rs`: 8 tests
  - `crates/ade-runtime/src/provider_worker.rs`: 4 tests
  - `crates/ade-core/src/contract/providers.rs`: `provider.registrations` round trips

## Verified only statically

- The four bundled providers resolve through the registry in catalogue order, and a test checks this. Their launch functions are the same calls the old `match` made. No real provider was launched.
- `Worker::spawn` and the `Provider` implementation for workers were never run against a real worker process. Only the handshake, history and path checks have tests.
- The `provider.registrations` handler and `Plugins::provider_workers` compile and pass Clippy, but no test calls them.

## Needs E2E or UI later

- F023 acceptance: install a separate provider package through `plugin.install`, enable it, discover its capabilities, run a turn, disable it, and read the history back.
- A worker crash during a turn must end the run with an exit event and must not redispatch the turn.
- A session on version 1 must continue after version 2 is installed and enabled.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 10 | 15 | 0 |

## References

- Paseo (Apache-2.0), `packages/plugin/src/server/provider.ts`, studied as a pattern for one provider registration contract with protocol versions negotiated at connect. Nothing was copied.
- The existing ADE plugin activation fence (`crates/ade-daemon/src/plugins/activation.rs`) was the pattern for `may_unregister`.

## Open

- **Conversation creation on plugin providers.**
  - `conversation.create` validates against the static descriptors in `ade-core::provider`.
  - `sessions/agents.rs` builds `Spec` with `worker: None`.
  - The conversations domain must do three things:
    - resolve a `plugin:` provider through `Plugins::provider_workers()` and `registry::lease`;
    - persist the leased `ProviderWorkerPin` on the conversation;
    - pass it in `Spec.worker`.
- **Lease retention in the daemon.**
  - `plugin.uninstall` removes `artifacts/<id>/` even when a live run leases an artifact under it.
  - The registry must refuse or defer this using `registry::retirable` against the runtime's `agent.list` pins.
  - Installing a newer version keeps older version directories, so upgrade is already safe.
- **Contract gap.** `AgentRunSpec` in `contract/agents.rs` has no `worker` field. `agent.list` for a plugin run would include it outside the schema. The coordinator or the agents slice should add it.
- **Readiness.** `provider.readiness` and `provider.capabilities` do not cover plugin providers. The capability record for a plugin provider exists only after its handshake.
- **Accounts.** Plugin providers refuse managed accounts, and generic adapters are not yet launchable from a conversation (F024 slice).
