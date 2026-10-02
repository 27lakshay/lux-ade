# 13 — Reconnect and merge history with live output

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Reconnect to runtime-owned work and merge retained history with live updates exactly once without resubmitting input or claiming an incomplete view is caught up.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC05, PC14, PC17, PC18, PC28, PC31, PC34, PC36. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Daemon restart reattaches to supported live runtime/provider instances; view lifetime and daemon availability do not imply provider death.
- [ ] Define a snapshot/feed boundary and stable merge identity. History replay, fresh live updates and command responses retain their distinct ownership.
- [ ] Acquire subscriptions before readiness, capture replay callbacks cheaply with byte bounds and normalize outside the callback. Updates arriving during drain cross an explicit replay/live barrier.
- [ ] Connected, replay complete and display caught up appear separately. Gaps, expired positions and overflow trigger explicit degraded recovery or resnapshot.
- [ ] Late reads/events after detachment or invalidation cannot mutate a successor view/session. Reconnection never issues the original prompt again.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Restart the real daemon while its runtime continues, overlap replay/live output and force cursor gaps; compare public outcomes and built-desktop catch-up.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
