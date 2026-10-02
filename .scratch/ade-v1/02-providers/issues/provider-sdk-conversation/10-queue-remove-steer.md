# 10 — Queue, remove and steer input without changing its meaning

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Prepare follow-up input, remove it where supported or steer an identified active turn without confusing local queues, native acceptance and redirection.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [05 — Stop an identified execution truthfully](05-identified-stop.md)

**Spec coverage:** PC04, PC06, PC07, PC08, PC37. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Expose Send, Queue and Steer only with declared semantics and current availability. CLI/SDK actions and desktop shortcuts cannot substitute one for another.
- [ ] Show whether input is ADE-pending, adapter-buffered or native-owned. Local removal cannot claim to recall already accepted native work.
- [ ] Steering targets a specific active native turn and fails on a stale target. Unsupported steering is explicit rather than another prompt.
- [ ] Cancellation discloses queued work that remains or applies supported scoped removal/escalation; a late queue acknowledgement cannot settle a successor.
- [ ] Work admitted during draining/cleanup survives and starts once when eligible. Different-payload operation reuse remains a conflict, not first-payload-wins.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Race queue ownership handoff, removal, steering and cleanup with deterministic native peers; assert actual received input and built-desktop queue states.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
