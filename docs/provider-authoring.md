# Authoring a provider worker

This guide is for someone adding a coding agent to ADE as an independently packaged provider plugin. A provider plugin and a bundled provider use the same worker protocol, supervisor and admission rules; nothing below is reserved for bundled code. The protocol reference is [provider-worker-protocol.md](provider-worker-protocol.md); evidence for the existing providers is in [provider-conformance.md](provider-conformance.md). Code wins if a page disagrees with it.

The worked example is the OpenCode plugin in `plugins/opencode`: it uses only `@ade/provider-sdk`, installs with `plugin.install`, and has fixture, installed and live evidence.

## Authority and packages

- The Rust contracts in `crates/ade-core/src/contract/providers.rs` are the authority. `pnpm contract:generate` produces `@ade/contracts` (types and validators); never edit the generated files. The SDK validates every request, reply and event against them at runtime.
- The compatible package set is exact: `@ade/provider-sdk` 0.2.0 (SDK API 2, worker protocol 2), `effect` and `@effect/platform-node` `4.0.0-rc.118`, Node 22 or later. Pin them exactly; declare them in `SDK_REQUIREMENTS`, which the runtime checks before it opens a session.
- Package the plugin's own production dependency closure into its artifact (`scripts/package-provider-plugin.mjs` does this for OpenCode and the SDK diagnostic). Do not rely on repository `node_modules`. Optional AI, MCP or observability libraries are allowed only where a component needs them, and their absence must leave the worker's declared behaviour intact.
- Before writing against a native agent or library, look up what it publishes for agents (`llms.txt`, an agent skill, an MCP server, its OpenAPI document) and record the version you verified against, as `plugins/opencode/PROVENANCE.md` does.

## The worker

```ts
import { runProviderWorker } from '@ade/provider-sdk/node'
runProviderWorker({ descriptor, dependencies: layer, acquire })
```

- `descriptor` declares protocol versions, capabilities, permission modes, operations (each with tier, availability and a reason when unavailable), limits and requirements.
- `dependencies` is an Effect `Layer` built once per worker process; `acquire` is a scoped `Effect` that returns the handlers. The SDK owns the runtime and scope: everything acquired is released when the worker closes, and `close` runs within the cleanup deadline.
- Handlers return `Effect`s and fail with a typed `WorkerFailure` (`code`, `message`). A defect becomes `integration_bug`, a fiber interruption `cancelled`, and a request still pending at shutdown gets no reply, which ADE treats as an unknown outcome. Never throw provider text into a failure without bounding it.
- If your code is Promise or AsyncIterable based, wrap it in `Effect.tryPromise` / `Stream.fromAsyncIterable` at the boundary. OpenCode keeps one Effect implementation (`src/session.ts`) and exposes Promise methods and an AsyncIterable of events on top of the same effects (`src/client.ts`), with identical typed errors.

## Effect conventions

ADE's own workers keep to a small subset of Effect 4; follow it unless a component genuinely needs more.

- **Services.** Model native state as one `Context.Service` with a `layer(options)` constructor (OpenCode's `OpenCodeSession`). Handlers are its methods; the factory's `acquire` reads the service and returns them.
- **Lifetimes.** `dependencies` runs once per worker process; `acquire` is scoped to the worker and released at `close`. Per-session state lives in that scope in bounded maps or `Ref`s, never in module globals, so a worker restart starts clean.
- **Queues and streams.** Native events go through a bounded `Queue` exposed as `events: Stream`. Pause reading the native source while the queue is mostly full and resume once drained, and stop parsing a buffered chunk at the pause too (the Codex worker holds the rest of a chunk for its resume; a burst of small frames otherwise overflows the queue).
- **Errors.** Fail with `WorkerFailure` values from typed causes; reserve defects for bugs. Do not call `Effect.runPromise` inside a handler; the SDK owns the runtime.
- **Diagnostics.** Run `@effect/tsgo` 0.47.1 (`effect-tsgo diagnostics --project tsconfig.json`, as `pnpm --filter @ade/provider-sdk effect:diagnostics` does) and keep it at zero findings.
- **Agent resources.** For the Effect version pinned here, read Effect's [`llms.txt`](https://effect.website/llms.txt) and the v4 guide [`LLMS.md`](https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md); v3 material (`Context.Tag`, `Effect.catchAll`, `Data.TaggedError`) does not apply to 4.0. Record the versions you checked against, as `plugins/opencode/PROVENANCE.md` does.

## Declaring what you do

- Declare an operation available only when the handler performs the native behaviour. ADE offers exactly what you declare: `send`, `cancel`, `answer`, `steer`, `compact`, `rewind`, `history`, `configure_mcp`, `child_transcript` and `account_inspect` all follow the declaration, for plugins as for bundled workers. An unavailable operation carries a reason a person can act on; ADE shows it as the reason the control or feature is unavailable.
- Conversation controls come only from the declaration, for every worker: steer, compact and conversation rewind are offered when `steer`, `compact` and `rewind` are available, and `conversation.controls` names the mechanism as the worker operation (`worker.steer`, `worker.compact`, `worker.rewind`). Which native method performs it is your worker's business; say so in your README.
- Capabilities (`tool_approval`, `questions`, `images`, ...) describe the native agent, not hopes. If the native agent runs tools without asking, do not declare tool approval.
- Each operation's tier comes from the contract: queries change nothing; idempotent commands may be repeated; effect commands carry an operation ID, and the daemon keeps the receipt. A retried effect with the same identity is the same request. For `send` the SDK runner does this for you: a repeat of a session's submission gets the first send's reply without reaching your handler while that send is pending or after it succeeded, a repeat with a different prompt is refused, and a failed send is forgotten so a deliberate retry reaches the native agent (the runner remembers the latest 256 submissions). Your other effect handlers (`answer`, `steer`, `compact`, `rewind`) must recognise a repeated operation ID themselves.

## Identities and ordering

- `open` returns the native session ID and must return the same ID when resuming. Never fabricate a native turn ID: report `turn: null` when the native agent has none, and ADE keys usage and rewind by submission and native message instead.
- Every event names its `session` and, where known, its `submission`. Output that no submission owns is reported with `submission: null`; ADE stores it as the session's own output and never invents a prompt for it.
- Report `submitted` with the native outcome only from native evidence: accepted, rejected or unknown. Acceptance is the native agent taking the prompt, not your write succeeding.
- Emit events in native order. Flush preceding output before a request, a terminal tool state, an error or a turn end. Report `finished` once per turn, with the native stop reason.
- `background` events report work the session still runs after a prompt yields; an exit leaves it unknown, never settled.

## Requests, cancellation and reconciliation

- A native approval or question becomes a request with a typed schema (choices with the native option values, questions, or permissions). Answer with exactly the native option the person chose; refuse an answer the request does not offer. Report withdrawal or expiry as `resolved` with that resolution.
- `cancel` is acknowledgement, not proof. Report `interruption_requested`, `termination` (`confirmed` only from native terminal evidence) and what work remains (`active_work_remaining`, `queued_work_count`, `background_work_remaining`), with null where you have no evidence. When a native agent goes idle without a terminal event (installed Oh My Pi does), end the turn from a fresh native state sample, and say so in your README.
- After a crash or lost reply, recover only by stable identity: operation IDs, submission IDs and native message IDs. Similar prompt text is never evidence. Never resend a prompt yourself; ADE asks the person before resuming a session that may continue interrupted work.

## History and scopes

- `history` reads a bounded page (at most 32 items, 512 KiB) of the native source without opening or resuming a session. Report the source's identity and generation so ADE can detect a changed source; keep unknown status and turn context unknown; leave private reasoning out.
- Scope native configuration (MCP servers, settings sources, permission modes) to what the person selected for the workspace and account; do not write the person's own native configuration files.
- Declare `configure_mcp` to receive the profile MCP catalog. It arrives before `open` at every launch and resume, in the provider-neutral `worker_mcp_json` shape described in the [protocol reference](provider-worker-protocol.md#public-methods); substitute `${NAME}` values from your launch environment and pass the servers to your agent's own MCP configuration for this session only.

## Managed accounts

- Declare `account_inspect` to let a person run your provider on ADE-managed accounts. Each account has its own private `native_home`. Read the account with `accountContext()` from `@ade/provider-sdk/node` (the `ADE_ACCOUNT_CONTEXT` variable) and point your agent's login, configuration and session storage at `native_home`; your `HOME` is already set to it, and ambient credentials are cleared from your environment.
- `account_inspect` reports `ready` with an `identity` object that names the login (an email, an organization), `signed_out` or `unavailable`, with a reason. ADE pins the identity when the person verifies the account and asks again before each `open` and `send`; a changed login is refused, never used.
- Without `account_inspect` your provider runs only on the agent's own login, and ADE says so.

## Framing and limits

- Input frames from ADE may be up to the `max_input_frame_bytes` you declare (at most 16 MiB, enough for ADE's 8 MiB of attachments base64-encoded). Output frames may be up to 4 MiB. Bound every queue, page and retained payload by bytes and count, and refuse rather than truncate silently.
- Diagnostics go to stderr, bounded; never log prompts, credentials or full provider output.

## Testing and evidence

### Conformance checks without ADE

`@ade/provider-sdk/testing` and its `ade-provider-conformance` command check a worker against the mandatory behaviour on this page and in the protocol reference, without the ADE app, daemon or runtime. The harness starts the worker, speaks the worker protocol to it as the runtime does, and validates every reply, event and frame against the Rust-generated contracts.

```sh
ade-provider-conformance --reply hello --hold hold --request ask -- node dist/worker.js
ade-provider-conformance --fixture test/conformance-fixture.mjs -- node dist/worker.js
ade-provider-conformance --fixture test/conformance-fixture.mjs --factory dist/provider.js#myProvider
```

The fixture is the only native behaviour you supply: prompts your deterministic native peer understands.

- `reply` (required) completes on its own. `hold` keeps running until interrupted and enables the cancellation check. `request` makes the peer ask an approval or question and enables the answer checks; the harness answers it with a refusing choice when one is offered.
- A fixture module's default export is a fixture, or an async setup function that stages the peer and returns the fixture with `env` for the worker and a `cleanup`. Its optional `nativeSubmissions()` returns how many prompts the peer has received, read from the peer's own record; with it, a retried send that reaches the peer fails even when the worker's output hides it. `providers/acp/conformance-fixture.mjs` is a complete example.
- `--factory <module>[#export]` runs a module exporting a `ProviderFactory` (or a function returning one) under the SDK's own `runProviderWorker`, so you can check a factory before writing its entry point.
- From code, `runConformance({ target, fixture })` returns the same report; `formatReport` prints it.

The worker inherits the current environment plus the fixture's `env`, so give the native peer private directories (the Claude fixture sets its own `CLAUDE_CONFIG_DIR`) rather than letting it write into a real home.

| Check | What fails it |
|---|---|
| `initialize.descriptor` | A descriptor the runtime would refuse: protocol 2, the exact `SDK_REQUIREMENTS`, contract tiers, host limits, duplicate or missing operations, an unavailable operation without a reason, permission modes not starting with `default` |
| `initialize.version_negotiation` | An `initialize` offering no compatible version that is not refused as `protocol_mismatch` |
| `operations.available_handled` | An available operation without a working handler (method not found or `integration_bug`), probed with identities the worker does not know |
| `operations.unavailable_refused` | An unavailable, unsupported or unknown method that is not refused with a typed failure |
| `open.resume_same_session` | Resuming the opened session in a new worker process returns another session |
| `send.turn_events` | No `finished` for the submission, more than one, no event naming the submission, output before `started` or after `finished`, or an event naming another session or an unsent submission |
| `send.retry_idempotent` | The same send again (same submission and message ID) runs the turn again, or reaches the native peer again |
| `cancel.evidence` | `termination: confirmed` with no terminal event for the turn, confirmation without a requested interruption, a malformed queue count, the turn finishing twice, or a repeated cancel answered as a defect |
| `answer.unoffered_refused` | An answer the request did not offer is accepted, or the offered answer is refused afterwards |
| `answer.retry_idempotent` | The same answer again (same operation ID) resolves the request a second time or fails as a defect |
| `frames.output_contract` | Any output frame that is not contract-valid JSON, answers an unsent or already answered request, or exceeds the declared `max_output_frame_bytes` |
| `frames.input_limits` | A malformed frame or a frame above the declared `max_input_frame_bytes` that is silently ignored or processed |
| `shutdown.pending_replies` | Not exiting with code 0 within `max_cleanup_ms` after stdin closes, answering the in-flight send `accepted` without native acceptance evidence, or reporting the held prompt finished successfully |

Each check reports `PASS`, `FAIL` with its reasons, or `SKIP` (not exercised) with why, for example an operation you declare unavailable or a prompt the fixture does not supply. A skipped check is a gap, never a pass. The command exits 1 when any check fails. Every report says it is deterministic fixture evidence: it cannot show that the real native agent, its installation or an account behaves the same, and it does not replace acceptance through the real daemon and runtime below.

`pnpm test:conformance` runs the command against the Claude worker (Agent SDK double), the ACP worker (fixture agent) and the packaged OpenCode plugin (mock server). Each fixture records the checks its worker is known to fail, with the reason; the run fails on any other failure, and when a recorded gap starts passing. The same runs are in each provider's deterministic tests, so `pnpm check:static` covers them, and `packages/provider-sdk/src/testing.test.mjs` proves each check fails on a worker broken in exactly that way.

### Deterministic and live evidence

- Ship deterministic tests against a native peer double (OpenCode's `test/`, Claude's SDK double, the Codex mock app-server) and run them through the real daemon and runtime in `e2e/protocol`.
- Record installed and live evidence separately, opt-in only, with the native version, your artifact digest, the account context and your capability matrix, as `docs/provider-conformance.md` does. A missing executable or credential is a recorded gap, never a pass.
