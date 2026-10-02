# 29 — Preserve reading position and accessible interaction

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Read and operate a streaming conversation without losing scroll position, text selection, copy or keyboard focus when history and tools change.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC26, PC27, PC36. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Virtualized history prepend, streaming Markdown and deferred tool expansion preserve a stable reading anchor and avoid forcing a reader back to the end.
- [ ] Text selection and copy remain usable during streaming; delayed content and repeated mounting do not steal focus or apply a disposed view’s position.
- [ ] Provide semantic keyboard navigation, labelled controls, focus restoration, request validation and screen-reader announcements appropriate to authoritative transitions.
- [ ] Respect reduced motion and existing theme contrast. Approved Pen surfaces remain intact; unapproved controls use stock provisional kit compositions.
- [ ] Measure local interaction costs and retain targeted browser tests; verify production selection/scroll/focus through built Electron rather than screenshots alone.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Exercise prepend/stream/expand and teardown in browser tests and built desktop; verify keyboard/reduced-motion and screen-reader semantics independently from pixel comparisons.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
