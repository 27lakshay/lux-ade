# 13 — Reconnect and merge history with live output

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Reconnect to runtime-owned work and merge retained history with live updates exactly once without resubmitting input or claiming an incomplete view is caught up.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC05, PC14, PC17, PC18, PC28, PC31, PC34, PC36. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Daemon restart reattaches to supported live runtime/provider instances; view lifetime and daemon availability do not imply provider death.
- [x] Define a snapshot/feed boundary and stable merge identity. History replay, fresh live updates and command responses retain their distinct ownership.
- [x] Acquire subscriptions before readiness, capture replay callbacks cheaply with byte bounds and normalize outside the callback. Updates arriving during drain cross an explicit replay/live barrier.
- [x] Connected, replay complete and display caught up appear separately. Gaps, expired positions and overflow trigger explicit degraded recovery or resnapshot.
- [x] Late reads/events after detachment or invalidation cannot mutate a successor view/session. Reconnection never issues the original prompt again.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Restart the real daemon while its runtime continues, overlap replay/live output and force cursor gaps; compare public outcomes and built-desktop catch-up.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Most of this slice existed: runtime-owned runs survive daemon restarts and reattach; the SDK projection subscribes before loading, buffers frames during a snapshot, drops duplicates, merges messages by ID and resnapshots on a gap, boot change or reload; late results are fenced by boot, revision and disposal. This ticket closed the gaps found in review.

Decisions:
- The conversation view states three facts separately in a provisional "Sync status" line: whether the daemon feed is connected (with the client's reason when not), whether the view's history replay is complete (`loading`, `stale` "replaying history after a gap", `degraded`, `current`), and which revision is on screen. While disconnected it says the shown revision may be out of date. Before, a `stale` repair was invisible and a disconnected view looked current.
- The revision on screen is the last one that changed this conversation; frames about other things advance the client without re-rendering the view, so it may be below the client's global revision.
- A feed subscriber evicted for a full queue now receives a final `feed_overflow` frame after its queued frames, and the SDK client reconnects with that reason instead of a generic disconnect. A subscriber whose socket stopped taking writes cannot receive it and still sees only a close.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-9aa480dc-3f33-49cb-8557-66560765338d`).
- Built Electron: `e2e/desktop/reconnect.spec.ts` (a daemon kill mid-tool: the view keeps its content and says it may be out of date; the tool process keeps running; after restart the view reports connected, replayed and caught up; the tool result renders once; one `turn/start`). Screenshots `reconnect-offline.png`, `reconnect-caught-up.png`.
- Real processes (existing, rerun in `test-results/runs/protocol-322e5fda-b0ac-4c2d-a378-8fc695bb098d`): `recovery/daemon-restart.spec.ts`, `reliability-b/consistent-view.spec.ts`, `reliability-b/stale-results.spec.ts`, `reliability-b/slow-subscriber.spec.ts`, `reliability-core/stream-fencing.spec.ts` pass.

Not covered: the `feed_overflow` frame reaching a client that is still reading has no deterministic test (the slow-subscriber client stalls its socket, so it sees the close only). Expired native history positions keep the existing `restartRequired`/`degraded` handling from ticket 12.
