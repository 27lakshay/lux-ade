# 19 — Preview and execute rewind with lineage

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Review supported rewind scope, execute it explicitly and retain any new native session lineage without confusing history with file restoration.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC02, PC19, PC34. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Preview the selected boundary and native-supported conversation/file effects, including unavailable restoration limits.
- [ ] Execute through effect admission and reconcile uncertain outcome without a duplicate rewind.
- [ ] If the provider forks or replaces its native session, record old/new identity and lineage explicitly rather than silently changing the conversation handle.
- [ ] Fence old events, stale pages and outstanding requests from the new lineage. Retained history remains readable with accurate provenance.
- [ ] CLI/SDK and desktop expose the same scope, preview, native result and recovery actions.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use native peers that rewind in place and fork sessions; race old pages/events and lose acknowledgement, then inspect lineage in built desktop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
