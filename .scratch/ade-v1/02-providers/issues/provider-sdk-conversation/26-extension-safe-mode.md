# 26 — Recover from thrown and frozen UI extensions

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Recover a usable conversation after an extension throws or freezes, with retained history, requests, drafts and Stop available.

**Blocked by:** [04 — Answer native approvals and structured questions](04-native-requests.md), [05 — Stop an identified execution truthfully](05-identified-stop.md), [24 — Render namespaced timeline content with a core fallback](24-timeline-contributions.md), [25 — Extend the composer without losing recoverable input](25-composer-contributions.md)

**Spec coverage:** PC12, PC13, PC22, PC24, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Thrown timeline/composer errors remain local and show core-readable fallback; a failed custom request form leaves core-supported actions available.
- [ ] A frozen renderer follows Electron’s recovery path into a fresh plugin-disabled renderer rather than relying on a watchdog inside the blocked renderer.
- [ ] Recover pending requests, durable draft/send identity and unknown outcomes from authoritative state; recovery does not re-answer or resend automatically.
- [ ] Stop and supported reconciliation remain available in safe mode. Renderer recovery does not terminate runtime-owned work implicitly.
- [ ] Display which contributions are disabled and preserve usable diagnostics without leaking native private data or widening unknown request permissions.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Throw and deliberately freeze installed UI contributions in built Electron against scratch real backends; verify recovery, request identity, draft retention and reachable Stop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
