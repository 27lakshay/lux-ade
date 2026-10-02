# 20 — Connect generic ACP agents with negotiated semantics

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Configure a compatible ACP executable and complete a conversation using negotiated capabilities and explicit lifecycle limits.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC02, PC08, PC09, PC12, PC18, PC30, PC31, PC33. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Use the official protocol SDK inside the adapter with pinned declarations and peers. Configuration suffices for existing protocol behavior; it cannot invent unsupported native operations.
- [x] Complete native-shaped send, tools and permission flows through the public worker SDK and production UI, preserving native permission outcome identifiers.
- [x] Acquire subscriptions before issuing work and handle load updates before replies. Bounded replay capture and explicit drain barriers keep replay separate from new live output.
- [x] Distinguish load/replay, supported resume without replay and native session creation. Capability negotiation and version mismatches are observable before unsupported execution.
- [x] Cancellation drains or reports the declared native outcome; close/timeout/process exit and child activity cannot settle or attach to an unrelated turn.
- [x] Document per-executable capability limits and validate the existing additional roster only with its own evidence, without claiming universal ACP/native parity.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Drive ACP startup, replay-before-reply, slow drain, permission, cancellation and close races with real-process peers and built desktop; separate installed executable evidence.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
2026-10-02: Generic ACP rebuilt as a public provider SDK worker (decisions taken under the user's standing instruction to decide unattended).

Built and deleted:
- `providers/acp/` (`worker.mjs`, `session.mjs`, `normalize.mjs`, README) speaks ACP through the official `@agentclientprotocol/sdk` 1.5.1, pinned exactly with its `zod` 4.6.5 peer (1.7.0 was hours old and outside the release-age policy). The runtime launches it for `adapter:<id>` definitions of kind `acp` (`Worker::spawn_acp`); `adapter.probe` runs it and stores its descriptor.
- Deleted the Rust ACP path (`crates/ade-runtime/src/adapters/acp.rs`, `acp_session.rs`) and the `AcpHandshake` contract (D19). `ProbeOutcome::Ready.worker` now carries the worker `initialize` reply; `ProviderWorkerInitialize.native_peer` (optional) reports the negotiated peer.

Decisions:
- Negotiation finishes before the worker answers its own `initialize`; a mismatch or failed negotiation leaves open/send/cancel/answer unavailable with the reason, so the probe fails before any session.
- Wire order is observed at the SDK transport boundary because the SDK dispatches messages without awaiting earlier ones. A prompt owns exactly the updates between its request and its reply; the `session/load` reply is the replay drain barrier.
- `session/resume` is preferred when declared (ADE holds the transcript); otherwise `session/load` with bounded capture. Replay merges only by native identity (message ID, tool call ID); replayed user prompts are not imported; gaps are declared in a notice item.
- No fabricated native turn: correlation is by submission; acceptance comes from the first content update or a result reply. An agent exit before evidence leaves the prompt unknown, and resume then requires `continue_interrupted`.
- Choice values are the agent's `optionId`s, with `persistent`/`once` scopes from the option kind.

Evidence:
- `pnpm check:static` passed (`test-results/runs/static-70e4a440-53b5-4b35-ba5d-59e290a6bae2`), including `providers/acp` normalize 9 and worker 8 tests against the fixture agent.
- Protocol `e2e/protocol/adapters` (`test-results/runs/protocol-51d10d7e-8ffe-476e-ac47-7304fc4cd55f`): 17 passed, 1 skipped (the opt-in live spec); ACP spec 9 tests cover negotiation, startup/late output, permissions, Stop with drained output, tools/plan/usage, burst ordering, load replay barrier, resume without replay, termination, replay bounds and identity gaps.
- Built desktop `e2e/desktop/acp.spec.ts` (`test-results/runs/desktop-50e8363b-7f10-4817-9368-6e0427d2c1c0`, with `omp` and `native-requests`): permission answered in the window with the agent option `allow-always`, Stop confirmed by the native `cancelled` reply.
- Installed/live, OpenCode 2.0.22 `opencode acp`, scratch directories under `/tmp/claude-501`: worker-level `live.test.mjs` and daemon-level `e2e/protocol/adapters/acp-live.spec.ts` (`test-results/runs/protocol-c66f3180-7193-424c-9fb4-32ec44594e84`) each completed one prompt (`end_turn`, reply `ok`); session resume via `session/resume` without a prompt.

Not covered: live cancellation, permissions and load replay on OpenCode; any other ACP executable. Ticket status is unchanged pending review.

2026-10-02: Accepted after review and integration (decisions taken under the user's standing instruction to decide unattended).

The implementation above was built in an isolated worktree, reviewed, and applied to agent-work-2 together with the parallel work on tickets 20, 21 and 24–26 (conflicts in the workspace list, provider test runner and provider README merged by hand; generated contracts and the lockfile regenerated here, not copied). On the merged tree: `pnpm check:static` passed (`test-results/runs/static-e687aa37-a5b5-4dd7-b805-3de4575087b5`); `e2e/protocol/adapters` 24 passed with 3 opt-in live cases skipped, and `plugins/ui-contributions.spec.ts` passed; built Electron `acp.spec.ts`, `plugin-ui.spec.ts` and `opencode-plugin.spec.ts` 7/7.
Full runs on the merged tree: protocol 1097 passed, 6 failed, 8 skipped; the six also fail on HEAD (conversation delete after a daemon kill, lost turn, theme validation and three escaped-descendant cases). Desktop 118 passed; the `plugin-ui.spec.ts` cases failing in that run were caused by a fixture change made mid-run and pass 6/6 on the rebuilt tree (`test-results/runs/desktop-ea7ff3c7-a195-4965-b213-b4e50094c7b9`), with `appearance.spec.ts` density passing on rerun.

Accepted as built. Live evidence is limited to OpenCode 2.0.22 `opencode acp` (completion and resume); cancellation, permissions and load replay against a real ACP agent are not covered, and no other ACP executable is verified (`providers/acp/README.md`).
