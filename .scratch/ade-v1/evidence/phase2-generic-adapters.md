# Generic ACP and custom executable adapters

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-6
Worker: Phase 2 round D, slice generic-adapters
Requirements: F024 (advanced, not accepted); F022 (roster proposal only, for D03); D04 (generic protocol coverage recorded)

## Outcome

A profile can now define, validate, list, probe and remove generic adapters through typed `adapter.*` operations and the `ade adapter` CLI. `ade-runtime` gains a generic ACP v1 adapter and a custom-executable adapter, both behind the ordinary `Provider` trait. An ACP adapter's capabilities come only from the agent's `initialize` response. A custom executable declares only `streaming` and `cancel`. F024 is not accepted: conversations cannot yet launch an adapter (see Open), and no E2E or real-agent evidence exists.

- **Definitions** live in `sessions.sqlite`, table `provider_adapters`, created idempotently by `crates/ade-daemon/src/adapters.rs`. They are validated by `ade_runtime::adapters::validate`. The command must be an absolute path, and ADE does not search `PATH`. Arguments and environment are bounded. Environment names that look like credentials (`*_TOKEN`, `*_API_KEY`, `*_SECRET` and similar) are refused, because the definition is stored in plain text. Unknown fields are refused.
- **Revisions and probes.** `adapter.put` stores a whole definition. Repeating an identical definition changes nothing. A different definition bumps the revision. A probe records the revision and the executable's file identity (device, inode, size and modification time). `readiness` is `stale` once either changes. A probe is saved only if the definition is still at the probed revision, and `expected_revision` fences both put and probe.
- **ACP adapter** (`crates/ade-runtime/src/adapters/acp_session.rs`). It speaks JSON-RPC 2.0 over stdio and supports these methods:
  - `initialize`, which must return protocol version 1; any other version is refused.
  - `session/new`.
  - `session/load`, only when the agent declared `loadSession`. It replays history into `Connected.history`.
  - `session/resume`, only when the agent declared `sessionCapabilities.resume`.
  - `session/prompt`, which runs on its own thread because it replies only when the turn ends.
  - `session/cancel`, which also answers open permission requests with `cancelled`, as the protocol requires.
  - `session/request_permission`.

  ADE declares no file-system, terminal or elicitation client capability, so any other agent request is reported unsupported and refused. If the transport ends mid-turn, the adapter emits no `Finished`. The exit event reports the outcome as unknown instead.
- **Permission meaning is preserved.** `accept` selects the agent's `allow_once` option and `decline` selects `reject_once`. A persistent (`*_always`) option is chosen only when named by `answers.option_id`, and the named option must match the decision. If there is no once-only option and none is named, the answer is refused.
- **Custom executable** (`crates/ade-runtime/src/adapters/executable.rs`). It runs one process group per turn. The prompt goes to stdin or the final argument, and stdout streams back as one assistant message, capped at 1 MiB. Stderr is drained and never shown. There is a per-definition timeout of 1 to 3600 seconds, and cancel is supported. A turn is reported `completed` only after the whole process tree is proven stopped. An unproven tree fails the turn and closes the adapter. It has no resume, approvals, questions or attachments; each is refused with a capability error.
- **Transport change** (`crates/ade-runtime/src/rpc.rs`). This was additive and wire-compatible for the existing bridges. `Rpc::spawn_with` takes a stateful decoder and a `Framing` (`Bare` for the existing bridges, `JsonRpc2` for ACP). `request_within` takes an optional limit, and `is_closed` was added. `Rpc::spawn` and `request` behave as before.

## Operation tiers

| Operation | Tier | Note |
|---|---|---|
| `adapter.list` | query | Computes readiness against the executable's current identity |
| `adapter.put` | idempotent command | Identical definition leaves the stored definition and revision unchanged; optional `expected_revision` (0 means must not exist) |
| `adapter.remove` | idempotent command | `removed: false` when absent |
| `adapter.probe` | idempotent command | ACP `initialize` has no agent-side effect; a custom executable is inspected, not run, because running it would send a prompt |

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build, typecheck, Fallow, JS build, JS pure tests, Clippy, legacy Rust tests).
- In-process tests added:
  - `crates/ade-runtime/src/adapters/acp.rs` covers the ACP mapping over sample messages: the initialize handshake and version refusal, capability derivation, prompt blocks refusing undeclared attachments, streaming and tool-call folding, stop reasons, plan and usage, load replay, permission choice, and output bounds.
  - `crates/ade-runtime/src/adapters/executable.rs` covers the settle decider and incremental UTF-8 decoding.
  - `crates/ade-runtime/src/adapters.rs` covers definition validation and the default-config check.
  - `crates/ade-daemon/src/adapters.rs` covers the readiness decider.
- A throwaway smoke test ran once and was deleted, as the test policy requires. It is not part of the gate, and it used a scripted Python ACP agent, not a real agent.
  - **ACP path:** probe; `session/new`; a prompt with streamed text; a tool call; a permission request answered `accept`, which selected `allow_once`; `end_turn` producing completed items; `session/cancel` producing `interrupted`; `session/load` returning two history items.
  - **Executable path:** completed, timeout (failed after about 2 s), cancel (`interrupted`), exit status 3 (failed), and `Exited` after stop.
  - **Daemon and CLI:** against a live `ade-daemon` with the CLI, the smoke test covered idempotent put, probe to `ready`, and a changed definition to `stale`. It also covered the refusals: relative command, `GH_TOKEN`, a stale `expected_revision`, a missing executable (`failed`) and a non-ACP executable (`failed` after the 15-second probe limit). Remove was idempotent.
  - **Bug found and fixed by the smoke test:** device and inode can exceed a JSON-safe integer, so they are now decimal strings.

**Verified only statically or in process:** everything above except the smoke run. No real ACP agent (for example Gemini CLI or GitHub Copilot CLI) has been run.

**Needs E2E later:** connect a conforming ACP peer and a declared executable through a conversation. Unsupported operations must fail with capability errors (the F024 acceptance row). Also needed: permission once versus always through the daemon's answer path, and cancel with an open permission request.

**Needs UI later:** an adapter settings surface that shows readiness and the probed capabilities.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 115 | 10 | 12 | 0 |

## References

- Agent Client Protocol schema @ `schema-v1.23.0` (github.com/agentclientprotocol/agent-client-protocol, released 2026-09-18), `schema.json` and `meta.json`, studied. Checked: method names, `InitializeResponse`, `AgentCapabilities`, `SessionUpdate` variants, `StopReason`, `RequestPermissionOutcome` and `PermissionOptionKind`.
- Paseo @ ade-evaluation-2026-09-24, `packages/server/src/server/agent/providers/generic-acp-agent.ts`, pattern. Paseo builds a command-configured generic ACP client. ADE deliberately differs: Paseo declares capabilities from provider parameters, and ADE takes them only from `initialize`.
- Paseo @ ade-evaluation-2026-09-24, `packages/server/src/server/agent/providers/` listing, studied for the D03 roster proposal (copilot, cursor, kimi, kiro and trae ACP adapters).
- No code was copied. No `THIRD-PARTY-NOTICES.md` entry is needed.

## D03 proposal: additional bundled roster (for the coordinator to decide)

The primary three stay mandatory. Decision 7 of the spec says a generic adapter alone must not mark F022 complete. So each entry below would ship as a named, bundled descriptor with its own capability matrix and real-provider E2E. None has been verified in this slice.

| Candidate | Path | Why | Before it counts |
|---|---|---|---|
| OpenCode v2 | Existing owned bridge (`crates/ade-runtime/src/opencode.rs`, already in `descriptors()`) | Already implemented and advertised; managed accounts are refused today | Capability matrix and actual-provider E2E; decide managed-account support |
| Gemini CLI | Bundled ACP descriptor over the generic ACP adapter | Native ACP agent | Pin version and ACP launch flag; matrix from `initialize`; E2E |
| GitHub Copilot CLI | Bundled ACP descriptor over the generic ACP adapter | Native ACP agent; Paseo ships an adapter | Pin version and flag; matrix; E2E |

Proposed rule: a bundled ACP provider is a pinned definition (executable discovery, version check and launch flag) plus the generic ACP adapter. Its published capability matrix is what that pinned version's `initialize` declares, re-probed after an external CLI update (F027). Cursor, Kimi, Kiro and Trae are deferred until a user need is named.

## Open

- **Conversation launch (main gap for F024).** A conversation cannot use `adapter:<id>` yet. Wiring it needs changes in other domains:
  - `store/conversations.rs` calls `Config::validate(provider)`, which consults the static descriptor registry.
  - `agent_runtime::Spec` needs an optional adapter definition field that the daemon fills from `provider_adapters`, pinned by revision.
  - `provider::spawn` should dispatch `adapter:` IDs to `ade_runtime::adapters::spawn`.
  - `catalog.get` descriptors should include ready adapters with their probed capabilities.
  - `adapter.remove` should then refuse while a conversation or run uses the adapter.
- The runtime already handles a turn end: it re-runs `initialize` at launch, and capabilities come from that response, not from the stored probe.
- MCP servers are passed as an empty list to `session/new`; routing ADE's MCP catalog to ACP agents that declare `mcpCapabilities` is not done.
- ACP `session/set_mode`, `session/set_config_option`, models, `session/list`, `session/close`, `authenticate` and `elicitation` are not supported; the adapter accepts only the default configuration and refuses other settings.
- Agent thought chunks are not persisted, matching the Claude bridge's handling of private reasoning.
- Backup coverage: the new `provider_adapters` table in `sessions.sqlite` needs a backup-coverage decision (D15 slice).
- `usage_update` reports are forwarded with source `acp/usage_update`; the usage normalizer does not decode that source yet, so they count as unreported.
- Shared-file notes for the coordinator:
  - `crates/ade-runtime/src/rpc.rs` gained additive API (`spawn_with`, `Framing`, `request_within`, `is_closed`).
  - `crates/ade-daemon/src/sessions.rs` gained one field, one open line and one dispatch line.
  - `crates/ade-runtime/src/lib.rs` and `crates/ade-daemon/src/lib.rs` each gained one `mod` line.
  - `crates/ade-core/src/contract/providers.rs` now declares a `providers/adapters.rs` submodule so a capabilities/presets slice can share the domain file with a one-line merge.
