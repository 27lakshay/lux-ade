# 27 — Inspect child activity, usage and quota evidence

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Inspect supported child activity/transcripts and reported usage/quota while retaining their provenance, units and uncertainty.

**Blocked by:** [11 — Show yielded, background and autonomous activity](11-background-activity.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC02, PC10, PC11, PC29, PC35. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Child observations identify source parent/session/attempt and use explicit correlation. Child output cannot be attached to a parent turn by reused tool name or similar text.
- [ ] Supported child transcripts load within history bounds; unavailable access remains explicit, and tool context outside a page remains readable/incomplete.
- [ ] Display usage and quota with native source, units, observation time and freshness. Missing values do not become zero usage or invented billing estimates.
- [ ] Provider-native notices, exposed reasoning and file/command changes retain core content and links to existing ADE resources where supported.
- [ ] CLI/SDK and desktop agree on native evidence and supported limits; optional renderers cannot become the sole readable representation.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Emit child events with reused IDs, autonomous updates and partial usage through real-process peers; inspect provenance and missing-value presentation in built desktop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
