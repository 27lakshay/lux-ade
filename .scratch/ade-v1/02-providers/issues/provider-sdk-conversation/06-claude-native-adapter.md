# 06 — Run Claude Code through the public provider SDK

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Run native Claude Code in the production conversation through the public SDK while preserving its streaming-input, request and session semantics.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC02, PC05, PC06, PC08, PC09, PC12, PC20, PC30, PC31. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Select Claude, submit native input and render correlated text/tools through the same authoring contract and production UI used by Codex.
- [ ] Read exact installed SDK declarations and record pinned versions. Preserve async input ownership, native message/session identity and approval choices; unavailable optional capabilities remain explicit.
- [ ] Implement supported request and cancellation behavior through shared operations, including queued input survival and trailing output after interrupt. Do not implement steering by silently queueing.
- [ ] Native resume preserves requested identity or explicitly reports a fork. Restoring readable history does not claim an execution resumed.
- [ ] Publish a provider-specific capability/evidence matrix and record remaining installed/live prerequisites without presenting fixture support as native proof.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use native-shaped protocol peers and built-desktop flows for send, tool, request and interrupt; obtain separate installed/live Claude evidence during provider verification.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

### Claude worker implementation and evidence update

The provider-specific [capability, lifecycle and identity matrix](../../../../../providers/claude/README.md) now records the worker surface and its limits. This update records owned implementation evidence, not completion of every acceptance criterion above.

- The worker uses Claude Agent SDK 0.3.281 and Effect 4.0.0-rc.118. Installed evidence used Claude Code 2.1.286 and Node 24.19.0. ADE owns the public SDK descriptor, conversation state and local admission context.
- Stable native API message ID/block-index rows join stream deltas and final text. Exact native input UUID echoes govern submission correlation. Only the original ADE user Message.id becomes Item.client_id on its genuine user echo; other rows and imported history do not reuse it.
- canUseTool associates a request only through its matching observed native toolUseID owner and confirmed native input. Unknown/pre-echo and old/autonomous callbacks remain session-scoped with null submission and remain answerable. New regressions cover an old autonomous callback while a new input is pending and a positively identified native tool owner. The two unknown-owner cases failed before removing the active-submission claim.
- Native callback/request IDs remain separate from the local callback answer handle. Answer, native abort, pre-abort, stale answer and shutdown retain exactly-once local settlement. Absent native question options stay null rather than becoming a restrictive empty option list.
- Callback return, response_delivery acknowledgement, tool completion and Finished do not establish native request closure or effective permission grants. The SDK exposes control_cancel_request through the callback AbortSignal as native withdrawal/no-longer-awaiting, including interrupt or another client's answer; it does not expose a successful request-closed event through SDKMessage/CanUseTool. The worker emits no successful Resolved event from acknowledgement or turn completion. Pending-permission snapshot absence is not closure proof because SDK declarations allow inherited answerable prompts to be absent.
- Native initialization/readiness and strict resume failures propagate rather than substituting a new session. Native interrupt preserves trailing output and its terminal cause; only aborted_streaming/aborted_tools prove cancellation. A still-queued native input remains an explicit unsupported cancellation outcome.
- Native history/import and child pages traverse blocks with opaque cursors under the existing 32-item/512-KiB page bounds. They do not widen the event queue or global JSON admission limits. Private reasoning stays out of visible rows; missing membership, snapshot/cursor mismatch and oversized items fail explicitly.
- Native rewind accepts an exact SessionMessage.uuid locator for the prompt to drop, forks through its predecessor, checks retained native history, preserves durable aliases/task receipts and returns new/previous session lineage with conversation scope. It does not rewind filesystem effects or invent a native turn ID.

Commands exercised from the repository root:

```sh
node --test providers/claude/worker.test.mjs
ADE_CLAUDE_LOOPBACK_BIN=/Users/lakshyakumar/.local/bin/claude node --test providers/claude/loopback.test.mjs
```

The callback-ownership repair passed 20/20 worker process regressions and 1/1 installed SDK/CLI loopback check. The installed run executes the real native Bash permission/tool path, stream abort, persisted history, strict resume, native fork, fork continuation and resumed fork. Its permission assertion checks observed native ownership and confirms that callback answer plus native tool completion emits no successful request-closed event.

Evidence limits remain explicit:

- Deterministic worker tests replace only the official SDK import with a native-shaped test peer. They are producer-contract/race evidence, not installed or live-provider proof.
- The installed loopback uses the real SDK/CLI with isolated HOME/config/data and a synthetic local API, not live provider credentials. Its child case seeds SDK-format storage and exercises actual list/read APIs; it does not claim an actual Agent spawn. The installed test is skipped without ADE_CLAUDE_LOOPBACK_BIN, and the deterministic provider runner excludes installed/live files.
- The daemon owner previously reported three passing approval/question cycles using the command below. That run predates the stricter closure and callback-association changes; it is historical evidence, not the current full acceptance result. The owner is extending/rerunning the real-daemon assertions. Built-desktop acceptance and the required current project-wide gate are not claimed by these worker checks. No credentialed live Claude run is recorded.

```sh
pnpm exec playwright test --config playwright.protocol.config.ts e2e/protocol/conversations/requests.spec.ts -g "a codex approval|a claude approval|claude question" --workers=1 --reporter=line
```

### Fresh normal-request daemon evidence after attribution repair

The focused command below passed 2/2 real daemon/runtime tests after the normal approval/question SDK fixture began emitting its genuine user UUID echo and assistant tool_use owner before invoking canUseTool. The fixture no longer shadows its native input message with tool arguments, and its callback record now includes the native toolUseID.

```sh
pnpm exec playwright test --config playwright.protocol.config.ts e2e/protocol/conversations/requests.spec.ts -g "a claude approval|claude question" --workers=1 --reporter=line
node --test --test-name-pattern="session-scoped|old autonomous|observed native tool owner" providers/claude/worker.test.mjs
```

The ownership regression command passed 3/3. Normal observed-owner callbacks remain public and answerable; the pre-echo and old/autonomous cases retain null submission instead of claiming the new queued input.

The real-daemon unknown-scope path remains distinct. Tracing its reported failure found the legacy request guard in sessions/agents.rs rejecting every request without the active submission/turn, despite an exact native session match. The daemon owner is changing the shared request scope/reply contract to accept genuine session-scoped requests without inventing an input source attempt. This focused two-case pass does not claim that pending shared path, built-desktop acceptance, a complete static gate, native success closure/effective grant, or credentialed live-provider coverage.

### Structured foreground stop evidence and fresh owned proof

The Claude worker now returns the shared ProviderWorkerCancelResult instead of an empty acknowledgement. Native query.interrupt targets the current foreground turn of its SDK Query, not a native turn UUID, process termination, all queued work, or all background work. Its result reports scope: turn, interruption_requested: true, and termination: requested. Active work remaining, total queued work count, background work remaining, and native sample timestamp remain null. The SDK's still_queued UUID list covers only stamped main-thread commands, so its length is not a complete queue census.

Concurrent/repeated cancellation joins the original interrupt promise rather than claiming a fresh native acknowledgement. An admitted UUID reported still queued remains an explicit unsupported result. Native aborted_streaming/aborted_tools terminal evidence is separate from the command acknowledgement; native API failure after interrupt remains failure.

The existing commands below passed freshly after the structured result and new assertions: 20/20 worker process regressions and 1/1 installed SDK/CLI loopback. The installed stream check first decodes requested foreground interruption with unknown survivors and then independently observes native aborted_streaming. It uses the official installed SDK and CLI against an isolated loopback API, not live provider credentials.

```sh
node --test providers/claude/worker.test.mjs
ADE_CLAUDE_LOOPBACK_BIN=/Users/lakshyakumar/.local/bin/claude node --test providers/claude/loopback.test.mjs
```

The new same-session/unowned real-daemon request case and shared stop result still await their integration owner's readiness/proof. No new daemon, built-desktop, full static gate, credentialed live-provider, successful native request closure, or effective-grant acceptance is claimed by these owned checks.
