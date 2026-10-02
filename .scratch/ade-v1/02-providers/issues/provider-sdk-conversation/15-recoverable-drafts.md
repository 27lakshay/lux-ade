# 15 — Preserve composer drafts, recall and stash

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Recover unfinished TipTap input after a window crash or rejected send, and transfer, recall or stash it without another view overwriting it.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC06, PC24, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Preserve client-and-conversation draft ownership and revision conflicts through existing daemon/client journal mechanisms; the renderer does not become durable authority.
- [ ] Two views keep independent local interaction state. Explicit ownership transfer reports conflicts and preserves the prior recoverable input.
- [ ] Crash recovery, recall and stash retain text and context references. Send associates the draft with its admitted intent rather than clearing it into an unrelated retry.
- [ ] Failed validation or admission preserves the draft. Uncertain admitted delivery remains linked to that intent and cannot become an automatic duplicate send.
- [ ] Provide recoverable plain-text/context serialization for future extension nodes; unsupported input stays readable or sending is refused with an explanation.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Crash/reopen built Electron and race draft ownership through real public operations; verify retained input, revisions and existing send-intent reconciliation.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
