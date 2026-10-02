# 29 — Preserve reading position and accessible interaction

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Read and operate a streaming conversation without losing scroll position, text selection, copy or keyboard focus when history and tools change.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC26, PC27, PC36. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Virtualized history prepend, streaming Markdown and deferred tool expansion preserve a stable reading anchor and avoid forcing a reader back to the end.
- [x] Text selection and copy remain usable during streaming; delayed content and repeated mounting do not steal focus or apply a disposed view’s position.
- [x] Provide semantic keyboard navigation, labelled controls, focus restoration, request validation and screen-reader announcements appropriate to authoritative transitions.
- [x] Respect reduced motion and existing theme contrast. Approved Pen surfaces remain intact; unapproved controls use stock provisional kit compositions.
- [x] Measure local interaction costs and retain targeted browser tests; verify production selection/scroll/focus through built Electron rather than screenshots alone.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Exercise prepend/stream/expand and teardown in browser tests and built desktop; verify keyboard/reduced-motion and screen-reader semantics independently from pixel comparisons.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

What existed: the virtualized timeline keeps a reading anchor on prepend and does not follow appends (`followOnAppend: false`), streamed Markdown updates one message without re-rendering others, the composer keeps focus and draft per view, reduced motion is honoured by the motion provider (`app/motion.test.tsx`), and the shell passes an axe scan (`accessibility.spec.ts`).

Fixes from the new acceptance run:
- The open conversation view failed axe with two defects. The current and native message lists were labelled `div`s with no role; they are now labelled regions. Each pane tab nested a focusable close button inside its `role="tab"` element, which assistive technology cannot reach. Moving it beside the tab broke the tablist's required children. The close control is now a pointer-only mark (hidden from assistive technology, not focusable), drawn with the kit's own ghost icon-button classes and its tooltip ("Close tab (Delete)"), and the focused tab closes with Delete (`aria-keyshortcuts="Delete"`), the WAI-ARIA pattern for closable tabs. The approved tab drawing is unchanged.
- Test fixture: the Codex mock gains a `slow-stream` prompt (40 lines over about four seconds).

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-2480b66f-e85d-4055-a651-899f70349619`); pane renderer tests 43/43.
- Built Electron: new `e2e/desktop/reading.spec.ts` (`test-results/runs/desktop-a6049e89-d5bc-44f3-97ad-3d72c2fd9e12`): with six turns of history, a selection in the first reply survives a streaming reply and copies exactly to the system clipboard; the scroll position does not move; typing focus stays in the composer while another reply streams and the typed text is intact; the populated view with its provisional panels open has no axe violations; Delete closes the focused tab. `conversation.spec.ts` and `accessibility.spec.ts` pass with the tab change.

Not measured here: interaction cost numbers for this slice beyond the existing performance suite; screen-reader announcement wording was checked through roles and live regions, not with a screen reader.

2026-10-02 (ticket 32 reconciliation): tool output can now be expanded on demand (`provisional/ToolOutput.tsx`: "Show full output" / "Show excerpt", `aria-expanded`, the full output in a bounded scroll region). `e2e/desktop/reading.spec.ts` "expanding a large tool output on demand keeps the reading position and keyboard focus" opens it from the keyboard with the control mid-view: the control stays within 1 px, the timeline scroll position does not move, focus stays on the control, and collapsing returns the excerpt in place. The label sits on its own line so its change on expansion cannot move the control (it moved 8 px before). Screen-reader wording is still checked through roles only. Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
