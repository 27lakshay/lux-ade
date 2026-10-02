# 17 — Run provider commands and skills with explicit semantics

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Discover and invoke supported provider commands and skills while understanding whether an action executes locally, natively or as model input.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC02, PC06, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Expose native command/skill metadata with source, current availability, validated input and declared operation tier through public workers.
- [ ] Composer discovery and invocation preserve the provider’s actual behavior; slash syntax cannot silently change an effect into an untracked local action.
- [ ] Local commands and native command completion have distinct outcome evidence from a streamed model turn. Unsupported commands fail without consuming the draft.
- [ ] Preserve complete skill resources/provenance and external ownership according to existing selected skill scope; do not implement a new marketplace.
- [ ] CLI/SDK and desktop show corresponding results and native limits without provider-name branches in shared widgets.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use native peers for local/native/model-command distinctions and stale metadata, then invoke those actions in built Electron and inspect their operation evidence.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
