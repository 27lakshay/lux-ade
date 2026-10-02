# Claude native provider worker

## Evidence limits

The installed-provider check uses the real Claude Agent SDK and Claude Code CLI with an isolated loopback API. It does not use live provider credentials. The child-transcript check seeds SDK-format storage; it does not spawn a real Agent child.

Successful native request closure and effective permission grants remain unknown when the SDK supplies no authoritative evidence. A transport acknowledgement, callback return, tool result, or finished turn does not establish either fact. The installed SDK does not expose a separate successful request-closed event through `SDKMessage` or `CanUseTool`.

The worker checks below do not establish built-desktop acceptance or replace the project-wide static gate. Ticket 06 keeps those acceptance requirements separate.

## Runtime and pinned dependencies

`worker.mjs` implements the public `@ade/provider-sdk/node` authoring contract. ADE owns its descriptor, lifecycle, and durable conversation state. The worker uses the native `@anthropic-ai/claude-agent-sdk` query API; it does not translate Claude into a generic model API.

| Component | Version used by the recorded checks |
| --- | --- |
| Claude Agent SDK | 0.3.281, pinned in this package |
| Effect | 4.0.0-rc.118, pinned in this package |
| Public provider SDK | 0.2.0, workspace package |
| Claude Code CLI | 2.1.286, installed executable |
| Node | 24.19.0 |

ADE supplies `ADE_CLAUDE_WORKER_DESCRIPTOR`. `ADE_CLAUDE_BIN` selects an explicit native executable. `ADE_DATA_DIR` stores durable row aliases under `claude-forks` and native task-result receipts under `claude-task-results`. `ADE_E2E_CLAUDE_SDK` is the one named test seam: when set, the worker imports that module instead of the Agent SDK. Worker tests and the protocol suites point it at the deterministic double `worker-test-sdk.mjs` (sessions in `worker-test-store.mjs`, scripted turns in `worker-test-scenarios.mjs`). The runtime passes the variable through a managed-account launch only when the runtime itself was started with it. Packaging leaves the `worker-test-*` files out.

## Capability and evidence matrix

| Capability | Worker behavior | Evidence and remaining limit |
| --- | --- | --- |
| Fresh open and resume | Read native output concurrently with the SDK initialization handshake. Preserve the requested native session identity; reject native failure or mismatched identity. | Deterministic initialization/refusal cases and installed fresh/resume/missing-session checks. Readable imported history alone is not execution readiness. |
| Streaming input and visible rows | Admit one input at a time. Associate native UUID echoes exactly. Preserve text deltas, final text, tool calls/results, and native usage. | Process regressions and installed text/Bash execution. Foreign output stays visible without acquiring an active submission. |
| Permissions and questions | Preserve native tool/request IDs and native permission choices. Keep unknown callbacks session-scoped and answerable through their local callback handle. Preserve absent question options as null for free-text answers. | Proven/unknown ownership regressions, native Bash permission, and daemon protocol fixtures. No strict automatic review or effective-grant claim. |
| Callback lifecycle | Settle the local callback once. Remove its abort listener. A native callback abort withdraws the request; local shutdown does not fabricate withdrawal. | Answer/abort/stale-answer regressions. No successful Resolved event from an answer acknowledgement or a finished turn. |
| Identified interrupt | Fence the local submission and source attempt. Call native query interrupt. If the SDK says input remains queued, report `queued_work_count` so ADE keeps the Stop unresolved and offers termination. Preserve trailing native output. | Process pre-echo/stale-attempt/failure cases and installed stream abort. Only native `aborted_streaming`/`aborted_tools` terminal causes establish cancellation. |
| History and import | Use native session metadata and message UUIDs. Traverse visible blocks with opaque item cursors and snapshot/context fences. | Process paging/oversize checks and installed persisted-history checks. At most 32 visible items and 512 KiB per page; complete traversal does not require a large single page. |
| Child lifecycle and transcript | Preserve native task/tool fences and one child card. Verify native parent membership before reading a child. Keep private reasoning out of visible rows. | Process lifecycle/membership cases; 1,000 visible blocks traverse a single message under the 32-item cap. Installed SDK discovers and reads a seeded 70-block child log. Real Agent spawning is not exercised. |
| Conversation rewind | Use an exact native prompt locator. Fork before the prompt to drop. Verify retained native history and return new/previous native sessions with `scope: conversation`. Preserve durable row aliases and retained task receipts. | Installed native fork, retained text/tool rows, continuation, and fork resume. First-prompt rewind is unsupported. This operation does not rewind filesystem effects. |
| MCP configuration | Pass pre-open MCP configuration to the native query. Reject unsupported late reconfiguration explicitly. | Deterministic native-query configuration check; no live MCP service exercised. |
| Steering and typed compaction | Unsupported through this worker's optional operations. | No silent queueing as steering and no fabricated compact operation. |

## Identity and ownership matrix

| Name | Meaning and source |
| --- | --- |
| Native session | The explicit SDK `sessionId` or `resume` identity, checked against native messages. The initialization report has no `session_id` field. An explicit rewind reports a new session and `previous_session`. |
| Native input UUID | The SDK user-message UUID echoed by `uuid` or native user-message UUID correlation fields. Admission alone is not a native echo. |
| Event.submission | ADE correlation context, not a native turn. A callback may use it only when its native `toolUseID` matches an observed transcript tool owner with exact native input confirmation. Otherwise it is null. |
| Item.client_id | The original ADE user Message.id, only on its exact native user echo. Assistant, tool, result, plan, and imported history rows do not acquire that ID. |
| Text row identity | Native API message ID plus content-block index, shared by deltas and final assistant text. It is not a per-delta UUID. |
| Native message locator | `{ provider: 'claude', session, message_id }`, where message_id is `SessionMessage.uuid`. This is distinct from the API message ID and is the rewind boundary identity. |
| Native tool ID | `CanUseTool.options.toolUseID`; preserved as native_callback_id/native_item_id. A matching ID without a confirmed input owner still does not authorize submission association. |
| Native request ID | `CanUseTool.options.requestId`, the native control_request request_id. A native withdrawal uses this ID, not the local callback handle. |
| Local callback handle | Generated Event.Request.id. ADE uses it to answer the one local SDK callback. It is not the native request or tool ID. |
| Native turn | Unavailable in this SDK surface. The worker reports null rather than substituting a message, submission, or random ID. |

Rewind's locator names the user prompt to remove. SDK `forkSession.upToMessageId` is inclusive, so the worker forks through its predecessor. A native-only rewind request has `turn: null` and the required `operation` field.

## Request closure and permission authority

The SDK's native `control_cancel_request` names the request_id that the sender no longer needs answered. It may follow interrupt or another client's answer. The SDK routes it to the callback AbortSignal. The worker reports that native withdrawal without claiming a successful answer or effective grant.

Normal callback completion removes the local callback and abort listener. It proves local response handling, not native request closure. The SDK's pending-permission initialization snapshot is not an absence-based closure oracle: its declarations explicitly allow inherited answerable prompts to be absent. Do not mark a request Resolved from acknowledgement plus Finished, or infer persistent/session permission state from the choice the user submitted.

## Cancellation evidence

The structured cancel_result reports scope: turn because query.interrupt targets the current foreground turn of this native SDK Query. It does not identify a native turn UUID, terminate the CLI process, cancel every queued command, or stop all background work.

Successful native control acknowledgement reports interruption_requested: true and termination: requested, never confirmed. Without a still_queued survivor the worker leaves active_work_remaining, queued_work_count, background_work_remaining, and observed_at_ms null. It has no complete native survivor census or identity-verified state sample from this command.

The SDK's still_queued receipt covers only UUID-stamped main-thread asynchronous commands. Internally enqueued unstamped commands and background work are excluded, so an empty receipt is not a global queue count of zero. When the receipt names any surviving input, the worker reports that count as `queued_work_count` (and `active_work_remaining: true` if it is the admitted input) instead of failing; ADE then keeps the Stop unresolved rather than claiming it. A first-command pre-wait interrupt can also latch and abort that queued input later; a receipt does not itself prove immediate termination.

Repeated or concurrent cancellation of one admitted submission joins the original native interrupt promise. It does not dispatch another interrupt or manufacture a fresh acknowledgement. Only an exactly attributed native terminal result with aborted_streaming or aborted_tools marks that foreground submission cancelled; other native failures retain their original outcome.

## Bounds

Native events obey descriptor entry, frame-byte, and aggregate queued-byte admission limits. Overflow fails with `resource_limit` rather than silently dropping output. History/child page limits do not widen the event queue or global JSON limits.

History/resume/rewind traversal stops explicitly at 2,000 native messages. Tool correlation retains at most 256 calls and 12 MiB. History pages return an explicit oversized-item error without advancing a cursor or claiming completion. Child pages carry both `next_offset` and `next_cursor` so a caller can resume within one multi-block native message.

## Recorded checks

Run these commands from the repository root:

```sh
node --test providers/claude/worker.test.mjs
ADE_CLAUDE_LOOPBACK_BIN=/Users/lakshyakumar/.local/bin/claude node --test providers/claude/loopback.test.mjs
```

After the structured cancellation cutover, the same commands passed 20/20 process regressions and 1/1 installed SDK/CLI loopback check. The process proof preserves a native API failure after an acknowledged interrupt. The installed stream proof decodes foreground-turn/requested cancellation evidence with unknown survivors, then independently observes native aborted_streaming. The callback-ownership change also keeps the installed native permission answer plus tool completion free of successful request-closed events; its two unknown-ownership cases failed before the active-submission fallback was removed.

The loopback executable path above is the exact path exercised on this Mac. Use an explicit installed executable for other machines. Without `ADE_CLAUDE_LOOPBACK_BIN`, the installed check is skipped; that skip is not native proof. The deterministic provider test runner excludes installed/live test files.

The fresh normal Claude approval and question cycles passed 2/2 through real daemon/runtime processes after the fixture began supplying observed native input/tool ownership:

```sh
pnpm exec playwright test --config playwright.protocol.config.ts e2e/protocol/conversations/requests.spec.ts -g "a claude approval|claude question" --workers=1 --reporter=line
```

This command uses a native-shaped SDK peer, not a credentialed provider. It does not establish the separate unknown/autonomous session-scoped request path. The daemon's previous current-submission-only request guard rejected that path; its owner is updating the shared request scope/reply contract and associated assertions without adding false input ownership.

An earlier three-case Codex/Claude approval/question pass preceded the stricter native-closure and callback-scope corrections; it is historical rather than current full acceptance. Record the completed unknown-scope daemon assertions, built-desktop proof, and project-wide gate in ticket 06 when exercised. No credentialed live Claude run is recorded here.
