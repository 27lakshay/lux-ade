# 30 — Keep conversations and control responsive under load

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Keep conversations, reconnect and Stop responsive under concurrent output while reporting bounded overload honestly.

**Blocked by:** [05 — Stop an identified execution truthfully](05-identified-stop.md), [13 — Reconnect and merge history with live output](13-reconnect-live-merge.md), [24 — Render namespaced timeline content with a core fallback](24-timeline-contributions.md)

**Spec coverage:** PC16, PC27, PC31, PC33, PC34, PC36. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Record a reference machine, ADE artifact, workload and sampling method, then establish numeric budgets for opening, first response, input/Stop latency, history prepend, catch-up and retained memory.
- [ ] Bound SDK frames/RPCs/queues, replay capture, retained native payloads, decoded history and cleanup by bytes and applicable counts. Slow consumers cannot block unrelated conversations or critical control.
- [ ] Send leading visible output promptly and coalesce only compatible presentation updates. Flush preceding output before requests, terminal tool states, errors or turn boundaries; durable events retain order.
- [ ] Use the utility-process stream bridge and frame projection publication; avoid synchronous filesystem/network work in Electron main/renderer and avoid unnecessary work in suspended views.
- [ ] Overload or storage failure exposes degraded recovery/resource limits rather than silent drops or a false complete view. Stop stays reachable under declared emergency control limits.
- [ ] Repeated open/close and plugin disposal return resources within the measured policy; sanitized correlated diagnostics explain gaps without tracing every token or leaking prompts.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use isolated application performance workloads and real-process flood/storage-failure fixtures; operate Stop and reconnect in built Electron. Keep diagnostics separate from timing samples and publish exact measured budgets.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
