# 08 — Apply provider settings with accurate effective state

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Choose supported model, reasoning and permission settings and see the settings actually in effect after dependent changes or partial failure.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC20, PC32. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Settings metadata includes support, availability, source, limits and a revision bound to the current installation/account/session context.
- [ ] Apply the model before model-dependent modes or reasoning, rediscover valid choices and serialize conflicting configuration transitions before dispatch.
- [ ] Reject stale options and presets that conflict with current capabilities; validation does not implicitly change account or widen permission scope.
- [ ] A partial native failure reports applied settings, unapplied changes and recovery evidence. Atomic rollback is claimed only when native guarantees support it.
- [ ] CLI/SDK and desktop read the same effective values and actionable configuration errors, with no silent model or permissive-mode fallback.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use a peer whose modes change with its model, fail the second update and race revisions; verify native effects and effective settings through public APIs and desktop controls.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
