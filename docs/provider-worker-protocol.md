# Provider worker protocol, version 2

To write a provider plugin, start with [provider-authoring.md](provider-authoring.md); evidence for the existing providers is in [provider-conformance.md](provider-conformance.md). `ade-provider-conformance` (`@ade/provider-sdk/testing`) checks a worker against this page without ADE; see [conformance checks](provider-authoring.md#conformance-checks-without-ade).

ADE runs provider workers as Node processes speaking newline-delimited JSON-RPC 2.0 on stdin and stdout. Diagnostics go to stderr. Plugins declare `entry_points.provider` in `ade-plugin.json`. Bundled Codex uses the same public `@ade/provider-sdk/node` facade; its Rust-owned native client translates Codex app-server requests beneath that boundary, not around it.

Protocol v2 is a breaking cutover: ADE rejects v1 descriptors before opening a native session or dispatching an effect. Workers use `protocol_version: 2`, include `2` in `compatible_protocol_versions`, and declare SDK API `2` / `@ade/provider-sdk` version `0.2.0`. The authoritative contracts are in `crates/ade-core/src/contract/providers.rs`. The supervisor is `crates/ade-runtime/src/provider_worker.rs`. Code wins if this page disagrees with either.

## Node SDK and packaging

Import `runProviderWorker` from `@ade/provider-sdk/node` and descriptor helpers from `@ade/provider-sdk`. The runner validates descriptors, method-specific requests, replies and events against Rust-generated contracts. `Effect` and `@effect/platform-node` use the pinned `4.0.0-rc.118` release. The output sink respects stdout backpressure and reports write failure as `transport_failure`.

`providers/codex` is a workspace package with its own production dependency closure. Packaging deploys that closure, including the SDK, contracts and Effect, rather than relying on repository-level `node_modules`. Initialization reports requirements without launching the native client. The owned helper starts lazily when a native operation needs it.

The SDK diagnostic also derives its deployment lockfile from the shared root lockfile, with injected workspace packages, `--offline` and `--frozen-lockfile`. Legacy deployment is not supported: it can freshly resolve a peer outside the root pin. Its offline supply-chain check requires full publication metadata in pnpm's cache as well as tarballs. Hydrate only the locked SDK closure through an ordinary online scratch deployment; a scratch-only `trust-policy=no-downgrade` check populates the full trust/publication mirror without weakening the diagnostic or changing root modules. CLI command results retain the generated operation-response union; DTOs do not need arbitrary dictionary index signatures.

`scripts/package-provider-plugin.mjs` assembles an installable plugin artifact the same way for any workspace provider package: the package's files and its production closure, deployed offline from the root lockfile, with source maps, declarations and unreferenced TypeScript sources pruned. The SDK diagnostic and the OpenCode plugin (`plugins/opencode`, provider `plugin:ade.opencode`) use it; `pnpm build:sdk` builds both.

## Readiness

`provider.inspect` and `provider.readiness` for a plugin run only the `initialize` handshake. A worker that declares `open` or `send` `unavailable`, for example because its native executable is missing, is reported `unavailable` with that operation's reason, and readiness marks `provider.native_work` failed. Otherwise readiness is `installed_unchecked`: native readiness and sign-in are not checked.

## Identity and admission

A plugin provider ID is `plugin:<plugin id>`; plugins cannot claim bundled or `adapter:` IDs. Each run pins its installed plugin ID, version and artifact digest. Installing a replacement does not move an existing run. Removing its artifact makes that run unavailable. An `adapter:<id>` definition of kind `acp` runs the bundled ACP worker, pinned to the definition revision the run launched with; see [providers/acp/README.md](../providers/acp/README.md).

The worker starts in the workspace root with its provider and plugin identity in the environment. `ADE_NODE_BIN` selects Node. Caller-authored provider, account, execution or lineage context is not accepted by `conversation.history`.

On a managed account every worker, bundled or installed, receives the account in `ADE_ACCOUNT_CONTEXT` as a `ProviderWorkerAccountContext`: `account_id`, `provider`, `generation`, `native_home` and the `identity` ADE pinned when it verified the account. The Node SDK reads it with `accountContext()`. A plugin worker starts in an environment cleared of everything except `PATH`, `TMPDIR`, locale and terminal variables, with `HOME` at the account's native home; keep the agent's login, configuration and sessions there. Bundled workers get the same context; the runtime also sets the native variables their agent reads (`CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `CODEX_HOME` for the Codex app-server) in the same kind of cleared environment. Without a managed account the variable is absent and the worker uses the agent's own login.

## Public methods

| Method | Purpose | Required |
|---|---|---|
| `initialize` | Describe compatible protocol versions, capabilities, permission modes, operations, limits and requirements | Yes |
| `open` | Open or resume a native session under the supplied configuration | Yes |
| `send` | Submit the exact admitted prompt and attachments | Yes |
| `steer` | Steer the identified native turn; the reply has the `send` result shape | Yes |
| `cancel` | Interrupt the identified native turn and report evidence; see [Cancellation](#cancellation) | Yes |
| `answer` | Answer an approval or question, preserving the original native decision | Yes |
| `history` | Read a bounded pinned source page without opening or resuming a session | Yes |
| `configure_mcp` | Configure supported native MCP servers | No |
| `compact` | Request native compaction | No |
| `rewind` | Request native rollback | No |
| `child_transcript` | Read a bounded child transcript | No |
| `account_inspect` | Report which native login the managed account context holds | No |

The `initialize` result includes `protocol_version`, `compatible_protocol_versions`, `name`, `capabilities`, `permission_modes`, `operations`, `limits` and `requirements`. A worker that negotiates with its native peer before answering may add `native_peer`: the peer's protocol, stated version, name, version, declared features and sign-in method IDs. It is bounded evidence for probes and diagnostics and grants nothing. The generic ACP worker (`providers/acp`) reports its agent this way. Operation availability and tier are authoritative. An unavailable optional operation returns a typed refusal; capability names do not substitute for method availability.

`configure_mcp` receives the profile MCP catalog resolved for the workspace and provider, before `open`, at every launch and resume, when the worker declares it available. Codex, Claude and Oh My Pi receive their native shapes; any other worker receives the provider-neutral `worker_mcp_json` projection: per server, `{"type":"stdio","command","args","env"}` (with `cwd` when set) or `{"type":"http"|"sse","url","headers"}`, where an `env` or header value is the literal or `${NAME}` for a variable in the worker's launch environment, which the worker substitutes. `mcp.resolve` previews exactly what a provider receives and whether it is `wired`.

`account_inspect` makes a plugin provider support managed accounts. ADE runs it in the account's launch environment for `account.inspect`; it returns `state` (`ready`, `signed_out` or `unavailable`), a `reason`, an optional `version` and, when ready, an `identity` object (at most 4 KiB, never a credential). `account.verify` pins that identity. Before each `open` and `send` on the account the runtime calls `account_inspect` again and refuses if the login is no longer ready or its identity changed. Bundled workers declare it unsupported: ADE's bundled account probes read their logins before the worker starts.

Initialization has a maximum 15-second deadline; operations have a maximum 45-second deadline. Control requests have reserved capacity alongside ordinary requests. In the Node SDK, `cancel` has its own dispatch lane and reply slot, so a slow `steer` or `answer` never holds it. A resume must return the same native session ID. Codex resumes with `excludeTurns: true`; it does not hydrate a full transcript through `open`.

## Cancellation

A `cancel` reply is acknowledgement, not proof that work stopped. Its `evidence` declares:

- `scope`: what the interruption targeted (`turn`, `submission`, `session`, `process` or `unknown`).
- `interruption_requested`: whether the native interruption was issued at all.
- `termination`: `requested` until native evidence ends the target; report `confirmed` only from native terminal evidence.
- `active_work_remaining`, `queued_work_count` and `background_work_remaining`: null when the provider has no evidence.

Report queued native input that can still run in `queued_work_count` instead of failing the request. The daemon then keeps the Stop unresolved and offers termination.

The daemon owns the outcome. `agent.cancel` waits at most five seconds for the worker's reply and returns `delivery: pending` otherwise. The Conversation's `stop` record moves to `confirmed` on the targeted submission's native terminal event or on a runtime-confirmed process exit (`agent.terminate`). It moves to `unresolved` on a refusal, on remaining queued input, or when no terminal evidence arrives within 30 seconds. A refused or failed cancellation never terminates the provider implicitly.

## Resource boundaries

Input frames to a worker may declare up to 16 MiB, enough for a prompt with ADE's 8 MiB of attachments base64-encoded; the runtime refuses, before writing, any request larger than the worker's declared `max_input_frame_bytes`, so an oversized prompt is refused rather than ending the transport. Worker requests are scanned with a request budget that scales with that limit (`json_budget::within_request_budget`); native output keeps the stricter budget below. Native Codex frames may reach 4 MiB; ADE truncates any item past 1 MiB with a marker (F031). Output frames from a worker may declare up to 4 MiB, so an item can carry a full 1 MiB stored message with its tool output and envelope (F031). Both sides inspect raw JSON before materializing it, including unknown fields. The decoded policy limits nesting to 64 and nodes to 4,096, with an 8 MiB conservative reservation (`4 × encoded bytes + 512 × nodes`). This is an admission estimate, not a measured allocator peak.

History pages contain at most 32 items and 512 KiB of encoded items. The daemon independently budgets its final `Message[]`, including array delimiters, commas and escaping, and accounts for snapshot metadata and retained cache entries. An oversized first record returns `resource_limit`; it does not silently truncate a record or report source exhaustion. Output queues, pending calls and cleanup have explicit bounds. Shutdown closes the owned helper and confirms process exit instead of detaching it.

## Query-only native history

`conversation.history` accepts a conversation ID, an optional previously returned snapshot and native cursor, an optional history epoch, and page limits. The daemon derives the provider, execution, account and lineage context. It fences replies against ownership, epoch and source generation changes. Matching concurrent reads coalesce. Temporary query failures can return only an exactly identified retained page as stale, with a typed error and `complete: false`; this is not permission to replay effects.

A snapshot reports its native source and generation. `size_bytes: null` or absent means unknown; zero means a measured empty source. Page bytes are never presented as source size. `modified_at_ms` uses Unix milliseconds when known. File sources include measured size and replacement/change guards; virtual sources remain best-effort rather than claiming strong change detection.

Native history is oldest-first. Continuation advances forward through that source; it is not ADE's `before` pagination. `complete` means source exhaustion, not accepted or completed submission. Native timestamps retain native provenance. Unknown status or turn context stays unknown. Orphan tools retain their original `call_id`, input and output. Private reasoning is excluded.

Offline imported source IDs use canonical line/block keys where the physical line ordinal can be measured within the bounded prefix. Later records use byte/block keys. Active file projection uses an explicit `source-file:` namespace rather than claiming those keys came from the native producer. Only a proven stored item identity acquires an ADE message ID, delivery record and sequence. `Message.sequence = 0` means unknown ADE position; it is never a presentation index. Unmatched native source items and ADE live/pending evidence remain distinct. Reconnect/replay reconciliation is a separate contract.

`conversation.get` retains ADE sequence pagination and has a maximum/default page size of 32. Aggregate decoding also applies across stored rows, not only to each row separately. Complete-preview readers refuse an over-budget result rather than presenting a truncated page as complete. Native cursors must never be sent as ADE sequence boundaries.

`ade conversation history ID [JSON_OPTIONS]` exposes the native query directly. Pass `snapshot`, `native_cursor` and `history_epoch` from the previous reply to continue, with optional `max_items` and `max_bytes`. The CLI validates those options through the ordinary operation contract; it does not author execution or account context. `conversation export` instead reads `conversation.export` pages (oldest first, at most 32 messages each, cut to the reply budget) through the SDK writer `@ade/client/export`, and writes the complete retained history, its provider-continuity disclosure and each attachment's payload state without holding it all in memory. A page carries `boot_id`, `revision` and `history_epoch`; a change between pages refuses the export.

## Events and durable delivery

Worker `event` notifications carry the `Event` enum from `crates/ade-core/src/provider.rs`: submission, turn, item, delta, approval/question, completion, usage, background activity, failure and exit evidence.

A provider that reports no native turn IDs (Claude, Oh My Pi) keys its work by submission: a `usage` event names its `submission` so ADE records the turn's usage under it, and a rewind targets the prompt's native message locator (`native_message`) instead of a turn ID. A `background` event (`active`, `running`, `source`) reports work the session still runs after its prompt yielded; it is fenced to the current native session, and an exit leaves the work unknown rather than settled.

Codex public reasoning summaries travel through `item/reasoning/summaryTextDelta` and completed native item `summary` fields, with the original `provider_item_id`, native `reasoning` kind and turn identity. The adapter excludes `item/reasoning/textDelta` and raw reasoning `content`/`text`; those private fields do not enter shared history.

ADE persists the exact user's prompt and attachments at admission. Its delivery record distinguishes durable admission, dispatch, native acceptance/rejection/unknown outcome, and a correlated terminal result. Admission or dispatch alone does not prove native acceptance. An early terminal event becomes correlated only after acceptance identifies that exact native turn. A disconnect or timeout leaves an uncertain outcome; it does not turn into a definite refusal or erase known acceptance. Exact item identity suppresses duplicate prompt projection without text matching.

Codex submit replies without a string native turn ID are malformed acceptance evidence, not proof of rejection. ADE retains the exact admitted input, reports `invalid_data` with `unknown` native outcome and `reconnect_and_reconcile`, and returns that receipt on same-ID replay without dispatching again. The shared deterministic native peer flushes startup and turn notifications before replies without a submit-delay sleep; its `frames.jsonl` ledger records protocol order independently of daemon scheduling.

A worker exit or protocol break ends its run. ADE does not restart it or resend an in-flight turn because the native provider may already have acted. Recovery is explicit and preserves the admitted prompt and delivery evidence.
