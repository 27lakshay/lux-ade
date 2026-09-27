# e2e-adapter-launch

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-3
Worker: E2E round 2 workflow, slice adapter-launch
Requirements: F023, F024 (register acceptance passes as headless E2E with fixture peers); 04-S11 (the leased-provider part of the dev-reload story now passes); F028 (once-only versus persistent grants proven for ACP only)

## Outcome

Conversations can now run on `adapter:<id>` providers (generic ACP and custom
executable adapters) and on `plugin:<id>` providers (plugin provider workers).
This closes the F023 and F024 launch gaps named in `phase2-generic-adapters.md`,
`phase2-provider-plugins.md` and `e2e-plugins.md`.

The register acceptance of F023 and F024 passes as headless E2E. The peers are
fixtures: a Node ACP v1 agent, a shell custom executable and the plugin
provider worker. No real ACP agent was run, so real-provider evidence is still
missing (see Open).

## What changed

- **Validation.** `conversation.create` validates `adapter:` and `plugin:`
  providers against the descriptor their provider-registry entry publishes, not
  against the static list. Validation lives in
  `crates/ade-daemon/src/sessions/registered.rs` and
  `Store::create_registered`.
  - An adapter must exist and be `ready`, which means it was probed at its
    current revision against the current executable.
  - A plugin provider must be live, which means enabled with a `provider` entry
    point.
  - Both accept only what their descriptor allows. Today that is the
    `default` permission mode, and no managed account.
- **Pinning.** A conversation is pinned when it is created.
  - An adapter conversation is pinned to the definition revision and the
    adapter's creation time, in `adapter_conversation_pins`.
  - A plugin conversation is pinned through `Plugins::lease_provider`, with the
    conversation ID as the session. The lease keeps the generation and its
    artifact.
- **Launch.** The runtime `Spec` (and `AgentRunSpec`) carries the pin.
  - `Spec.worker` holds the leased worker. `lease_provider` now returns the
    whole `ProviderWorker`, with version and digest, instead of
    `ProviderLease`.
  - `Spec.adapter` is a new `AdapterPin { revision, definition }`.
  - `agent_runtime::launch` dispatches `adapter:` providers to an
    `AdapterEntry` and `plugin:` providers to a `WorkerEntry`. Each goes
    through `Registry::register` and `Registry::launch`, which call
    `provider::spawn` or `adapters::spawn`.
  - A recovered run keeps what it launched with.
- **Adapter edits.** A pure decider, `adapters::pin_decision`, handles a
  definition that changed after pinning.
  - A run already started keeps its definition.
  - A conversation with no native session moves to the new definition.
  - A conversation with a native session is refused. The refusal names the
    revision change, or says the adapter was removed and defined again. ADE
    never resumes a native session with a different agent command.
- **Catalogue.** `catalog.get`, the subscription frame and `catalog` pushes list
  the bundled descriptors plus:
  - each ready adapter, with the capabilities its probe discovered;
  - each live plugin provider, with the capabilities its worker declared in
    `initialize`. `catalog.get` handshakes each new artifact once, outside the
    session lock, and caches the result, including a failure, by plugin
    version and digest.
- **In-use refusals.**
  - `adapter.remove` is refused with `conflict` while a connected Agent, or one
    whose stop is unresolved, runs on the adapter.
  - `plugin.uninstall` is refused in the same case.
  - Once the plugin is disabled, `plugin.uninstall` releases the leases of idle
    conversations. Their history stays readable, and they refuse to run.
  - The session lock is held from the check through the removal.
- **Controls.** The availability table (`sessions/controls/availability.rs`)
  now names each adapter and plugin-worker limitation for steer, compact and
  conversation rewind. Before, it answered "Unknown provider".

## Acceptance criteria

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| F024 | Connect a conforming ACP peer and run turns on one native session | `adapters/acp.spec.ts` › an ACP adapter runs a turn… | pass |
| F024 | Only a probed, ready adapter is listed with its discovered capabilities and accepted. Unprobed, missing, a wrong permission mode, an account, and a protocol v2 peer are all refused | `adapters/acp.spec.ts` › an ACP adapter runs a turn… | pass |
| F024 / F028 | Permission: `accept` picks allow_once. A persistent grant needs a named option that matches the decision. `decline` picks reject_once. A repeated answer converges with one native reply | `adapters/acp.spec.ts` › permission answers keep once-only… | pass |
| F024 | Cancel ends a held turn with `session/cancel`. Cancel with an open permission request answers it `cancelled`. The session then takes new turns | `adapters/acp.spec.ts` › cancel ends a running turn… | pass |
| F024 | Unsupported operations fail with capability errors: steer, compact and rewind report the adapter limitation, and nothing reaches the agent | `adapters/acp.spec.ts` › steering, compaction and conversation rewind… | pass |
| F024 | Daemon crash (SIGKILL): the running ACP turn survives on the same agent process. An agent crash mid-turn ends the run without resending. Resume loads the same native session (`session/load`) and never opens a new one | `adapters/acp.spec.ts` › a daemon crash keeps the running ACP turn… | pass |
| F024 | `adapter.remove` is refused (`conflict`) while in use. An edit leaves the running agent on its pinned definition. Resuming an old session after the edit is refused. With no run left, removal succeeds, history stays readable, and the adapter leaves the catalogue | `adapters/acp.spec.ts` › adapter.remove is refused… | pass |
| F024 | A declared custom executable runs turns. Cancel kills the running process, and the turn is not sent again. Steer is unavailable. Resume after a runtime crash is refused with "cannot resume sessions" | `adapters/executable.spec.ts` | pass |
| F023 | Install a provider package through `plugin.install`. The catalogue shows its handshake capabilities. A turn runs. After disable, the history is readable. Uninstall is refused (`conflict`) while the run is connected and succeeds once it is stopped. The conversation then refuses to run | `adapters/plugin-providers.spec.ts` › a provider plugin runs a turn… | pass |
| F023 / 04-S11 | A conversation stays on v1 after v2 is installed and enabled, across a daemon crash. A new conversation gets v2. The old generation stays `leased` | `adapters/plugin-providers.spec.ts` › stays on the plugin version… | pass |
| 04-S11 | A dev-mode reload keeps a leased provider conversation on its old generation | `adapters/plugin-providers.spec.ts` and `plugins/dev-reload.spec.ts` (was fixme) | pass |
| F023 | A worker crash mid-turn ends the run with an error and does not redispatch (the worker records one send) | `adapters/plugin-providers.spec.ts` › crashes mid-turn… | pass |
| F023 | The round-1 fixme specs: a turn with history after disable, and a worker that dies before its handshake | `plugins/provider-plugins.spec.ts` (fixme removed) | pass |
| F024 | Real ACP agent (for example Gemini CLI) | none | not covered |

## Product fixes

- **F023 and F024 launch gap.** This is the main work of the slice; see What
  changed. It adds a pure-core test,
  `adapters::tests::a_started_session_never_moves_to_another_definition`.
- **Controls answered "Unknown provider" for adapters and plugins.** Test:
  `availability::tests::unsupported_providers_report_their_limitation_whatever_the_state`,
  extended.
- **Protocol gap in the provider worker protocol.** The document did not say how
  a worker echoes the user's prompt. The round-1 fixture echoed it with
  `kind: 'message'` and `client_id: message_id`. The first run then failed with
  "Message identity cannot change", and the fixture also produced a duplicate
  user message. `docs/provider-worker-protocol.md` now states the rule: role
  `user`, kind `text`, `client_id` = `submission`, and `id` = `message_id`. The
  fixture follows it. The fixture's turn IDs are now unique per process, so a
  resumed worker cannot overwrite an earlier reply that has the same native ID.

## New fixtures

- `e2e/protocol/fixtures/adapters/acp_agent.mjs` is a Node ACP v1 agent. Prompt
  text scripts it:
  - `permission` asks with three options;
  - `hold` waits for cancel;
  - `crash` exits;
  - any other text answers "Hello ACP".

  It supports `session/load` and records each message in `calls.jsonl`.
  `ACP_FIXTURE_PROTOCOL` changes the version it declares.
- `e2e/protocol/fixtures/adapters/exec_agent.sh` is a custom executable that
  prints "Echo: <prompt>". A prompt containing `hold` waits for a release file.
- `e2e/protocol/fixtures/adapters.ts` stages private executable copies and
  defines and probes adapters. It also reads what the agents received.
- `e2e/protocol/fixtures/plugins/provider/worker.mjs` has the two protocol
  fixes described in Product fixes.

## Operation tiers

No operation was added. These changed:

- `conversation.create` (idempotent command) accepts registered providers.
- `adapter.remove` (idempotent command) and `plugin.uninstall` (effect command)
  gained in-use refusals. The `plugin.uninstall` refusal happens before
  admission, so a retry after the run stops proceeds normally.
- `catalog.get` (query) may start a plugin worker once per new artifact for its
  handshake.

Contract changes:

- `AdapterPin` was added in `contract/providers/adapters.rs`.
- `AgentRunSpec.adapter` was added.
- `pnpm contract:generate` was run.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/adapters`: 11
  passed.
- `e2e/protocol/plugins` and `e2e/protocol/adapters` together with
  `--repeat-each 2`: 60 passed.
- `boot.spec.ts`, `conversations/` and `catalogs/`: 64 passed and 5 skipped. The
  skips are existing fixmes.
- `pnpm check:static`: pass.
- In-process tests added:
  - `crates/ade-daemon/src/adapters.rs`, `a_started_session_never_moves_to_another_definition`;
  - `crates/ade-daemon/src/sessions/controls/availability.rs`, an extended
    unsupported-provider test.
- `pgrep` found no `ade-daemon`, `ade-runtime` or fixture agent from this
  worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 25 | 0 |

## References

- lux-ade `.scratch/ade-v1/evidence/phase2-generic-adapters.md`,
  `phase2-provider-plugins.md` and `e2e-plugins.md` (the Open and fixme lists
  this slice closes).
- lux-ade `docs/provider-worker-protocol.md` (updated) and the ACP mapping in
  `crates/ade-runtime/src/adapters/acp.rs`. The fixture agent follows it.
- None copied from reference repos.

## Open

- **Real-provider evidence:** no real ACP agent (Gemini CLI, GitHub Copilot
  CLI) or real plugin provider was run. Only protocol fixtures were used.
- **Backup coverage:** the new `adapter_conversation_pins` table sits in
  `sessions.sqlite`, created idempotently like `provider_adapters`, with no
  migration number. It needs the same backup-coverage decision as
  `provider_adapters` (D15).
- **Delegation:** `orchestration` child creation still validates against the
  static catalogue, so a delegated child cannot use an `adapter:` or `plugin:`
  provider yet.
- **Readiness and capabilities:** `provider.capabilities` and
  `provider.readiness` still cover only bundled providers. Discovery for
  adapters and plugins is through the catalogue descriptors.
- **Provider config:** a `model` in `provider_config` is not refused at create
  for adapters. The adapter refuses it at launch ("declares no model…"), and
  the error is recorded on the conversation.
- **Plugin steering:** the availability table marks steer unavailable for
  plugin workers even when a worker declares `steering`. The daemon does not
  track the handshake per run.
- **Shared-file notes for the coordinator:**
  - `crates/ade-core/src/contract/agents.rs` gained one field on
    `AgentRunSpec`.
  - `crates/ade-daemon/src/sessions.rs` gained:
    - one `mod` line;
    - one field and its initializer;
    - routing for `adapter.remove` and `plugin.uninstall`;
    - the subscription descriptor list.
  - Generated contracts were regenerated.
