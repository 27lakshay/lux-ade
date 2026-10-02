# 18 — Compact context with native evidence

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Request supported native compaction and retain readable history with an honest native outcome.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC02, PC19, PC35. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Advertise compaction only with current native support/availability and preserve effect admission, receipt and unknown-outcome behavior.
- [ ] Report observed compaction results and affected history revision rather than marking success on request acknowledgement.
- [ ] Invalidate or refresh affected snapshots while retaining durable readable content and provenance.
- [ ] Repeated tool material after compaction does not become a second execution, and absent call context remains explicitly incomplete.
- [ ] Unsupported or failed compaction has the same visible/API meaning and cannot silently submit a replacement prompt.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Exercise native compaction acknowledgement, partial failure, lost reply and repeated history material through real processes and built desktop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
