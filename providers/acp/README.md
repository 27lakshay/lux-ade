# Generic ACP provider worker

`worker.mjs` runs any agent that speaks the Agent Client Protocol (ACP) v1 over standard input and
output as an ADE conversation provider. A profile defines the agent with `adapter.put`
(`kind: "acp"`: an absolute executable, arguments and non-secret environment). The runtime starts
this worker for each run of that definition (`Worker::spawn_acp` in
`crates/ade-runtime/src/provider_worker.rs`), passing the definition in `ADE_ACP_AGENT`. The
worker speaks ACP through the official TypeScript SDK, `@agentclientprotocol/sdk` 1.5.1 (pinned,
with its `zod` 4.6.5 peer), and ADE's public provider worker protocol through
`@ade/provider-sdk`.

Configuration selects only what ACP already defines. The worker declares a capability or
operation only when the agent declared the matching ACP feature in `initialize`, and records the
agent's report as `native_peer` in its descriptor. `adapter.probe` stores that descriptor.

## Lifecycle

| Concern | Behaviour |
|---|---|
| Negotiation | ACP `initialize` completes before the worker answers its own `initialize`. Another ACP version, a malformed reply or no reply within 10 seconds leaves `open`, `send`, `cancel` and `answer` unavailable with the reason; the probe fails with it and no session is created. |
| Wire order | Both SDK streams are observed at the transport boundary, in order. The SDK dispatches messages without awaiting earlier ones, so a reply could otherwise overtake the notifications before it. |
| New session | `session/new` with no MCP servers. Output the agent sends before a prompt exists (for example right after `session/new`) belongs to no turn. |
| Resume | `session/resume` when the agent declares `sessionCapabilities.resume`: no replay, because ADE already holds the transcript. Otherwise `session/load`. Neither declared: resume is unsupported. |
| Load replay | Updates for the session between the `session/load` request and its reply are replay; the reply is the drain barrier and later updates are live. Capture is bounded (512 updates, 2 MiB). Only identified entries become history: assistant text by native `messageId`, tools by `toolCallId`. Replayed user prompts are not imported, since ACP does not correlate them with ADE's admitted prompt. Anything omitted is declared in one notice item. |
| Turn | One prompt per session. `started` is emitted when the `session/prompt` request is written; the turn owns exactly the updates between that request and its reply. Text after the reply joins no later turn. `submitted: accepted` comes from the first content update or a result reply; an error reply before that is `rejected`. |
| Stop | `cancel` answers the turn's open permission requests with the `cancelled` outcome, sends `session/cancel` and reports `termination: requested`. Only the prompt's own reply settles the turn: `cancelled` is `interrupted`; `end_turn` after a cancel is still `completed`. |
| Exit and close | An agent exit fails the worker's event stream; the running prompt's outcome stays unknown and is never settled. On an orderly worker shutdown with a prompt running, the worker sends `session/close` if declared, otherwise `session/cancel`, and settles nothing. ADE's runtime ends a run by signalling the process tree, so these messages are best effort. |
| Permissions | Each `session/request_permission` becomes a choices request. Choice values are the agent's `optionId`s; `*_always` options carry the `persistent` scope and `*_once` options `once`. An answer must name an offered option. A refusal from ADE is a JSON-RPC error, never an implicit selection. |
| Not offered | Steering (ACP v1 has no steer), read-only history queries, compaction, rewind, child transcripts, elicitation questions, client file system and terminal services, MCP server configuration, models and permission modes. |
| Bounds | 8 MiB per agent message; 4 MiB of text per turn; 1 MiB per item; 1024 open tool calls; 32 permission options. Native JSON that does not fit the worker output policy (32 entries per container) is kept as truncated JSON text. The worker stops reading the agent while ADE drains its events. |

## Per-executable evidence

Generic ACP support is not ACP parity. Each executable has only the coverage recorded for it.

| Executable | Negotiated | Evidence | Limits |
|---|---|---|---|
| Deterministic fixture `e2e/protocol/fixtures/adapters/acp_agent.mjs` | ACP 1; `loadSession`; optional `resume` and `close` by environment | Worker tests (`worker.test.mjs`), protocol e2e `e2e/protocol/adapters/acp.spec.ts`, built desktop `e2e/desktop/acp.spec.ts` | Fixture only; calls no model. |
| OpenCode 2.0.22, `opencode acp` | ACP 1; `loadSession`, `resume`, `close`, `list`; image and embedded-context prompts; MCP over HTTP; auth method `opencode-login` | 2026-10-02: one live prompt through the worker (`live.test.mjs`) and one through the real daemon and runtime (`e2e/protocol/adapters/acp-live.spec.ts`); both completed with `end_turn` and reply `ok`. Resume reopened the session with `session/resume` and no prompt. | Cancellation, permissions and load replay were not exercised live. OpenCode sends message IDs with its chunks, so live and replayed items share identities. ADE's native OpenCode adapter remains separate. |

Any other ACP executable is unverified until it has its own entry.

## Tests

`pnpm test:providers --provider acp` runs `normalize.test.mjs` and `worker.test.mjs` against the
fixture agent. `live.test.mjs` is opt-in and sends one real prompt:

```sh
ADE_ACP_LIVE_BIN=$HOME/.opencode/bin/opencode ADE_ACP_LIVE_ARGS=acp \
  ADE_ACP_LIVE_ROOT=/tmp node --test providers/acp/live.test.mjs
```

Run it in a scratch directory only; it uses the agent's own sign-in and changes no agent
configuration.
