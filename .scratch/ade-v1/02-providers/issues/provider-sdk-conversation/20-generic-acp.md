# 20 — Connect generic ACP agents with negotiated semantics

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Configure a compatible ACP executable and complete a conversation using negotiated capabilities and explicit lifecycle limits.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC02, PC08, PC09, PC12, PC18, PC30, PC31, PC33. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Use the official protocol SDK inside the adapter with pinned declarations and peers. Configuration suffices for existing protocol behavior; it cannot invent unsupported native operations.
- [ ] Complete native-shaped send, tools and permission flows through the public worker SDK and production UI, preserving native permission outcome identifiers.
- [ ] Acquire subscriptions before issuing work and handle load updates before replies. Bounded replay capture and explicit drain barriers keep replay separate from new live output.
- [ ] Distinguish load/replay, supported resume without replay and native session creation. Capability negotiation and version mismatches are observable before unsupported execution.
- [ ] Cancellation drains or reports the declared native outcome; close/timeout/process exit and child activity cannot settle or attach to an unrelated turn.
- [ ] Document per-executable capability limits and validate the existing additional roster only with its own evidence, without claiming universal ACP/native parity.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Drive ACP startup, replay-before-reply, slow drain, permission, cancellation and close races with real-process peers and built desktop; separate installed executable evidence.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
