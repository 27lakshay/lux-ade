# 05 — Stop an identified execution truthfully

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Stop the identified active execution and distinguish requested cancellation from observed termination without stopping a successor or concealing queued work.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC08, PC09, PC16, PC23, PC28, PC36, PC37. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Stop declares its native scope and remaining queued/background work. A cancellation reply is acknowledgement; confirmed termination requires native or runtime-owned process evidence.
- [ ] Late output and cancellation are fenced by attempt/turn identity. Waiting for the targeted attempt’s settlement includes its cleanup without following or cancelling successors.
- [ ] Native queued input that can still execute prevents an unconditional stopped claim. Unsupported cancellation offers declared escalation or an explicit unresolved outcome.
- [ ] Cancellation and cleanup have bounded completion paths even without a consuming event reader. Control remains available under ordinary output backpressure.
- [ ] View closure only detaches presentation. Closing transports, suspending sessions and terminating owned processes remain separate actions with truthful limits.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Race Stop with dequeue, terminal output and successor startup through real processes; operate the built desktop and test absent event consumers and unconfirmed native stop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
