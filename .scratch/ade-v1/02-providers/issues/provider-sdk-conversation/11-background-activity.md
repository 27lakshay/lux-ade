# 11 — Show yielded, background and autonomous activity

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** See whether a prompt yielded, background work remains or autonomous output arrived, with attention and unread derived from authoritative evidence.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC10, PC11, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Represent delivery, execution, session activity, synchronization and user action independently, including their evidence source and unknown values.
- [ ] A yielded prompt can remain active through native background evidence; silence or transport connection state cannot prove settlement.
- [ ] Retain autonomous output without inventing a new user prompt and correlate it to its native session/attempt or disclose weaker attribution.
- [ ] Pending requests, errors and ordinary running indication produce consistent attention; unread uses separate seen marks. Existing selected snooze changes attention without scheduling execution.
- [ ] Fence stale settlement and interruption output from later activity, and keep CLI/SDK observations and desktop status in agreement.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Feed yielded/background/settled and autonomous transitions through real processes, including late stale observations; verify visible attention and unread independently.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
