# 25 — Extend the composer without losing recoverable input

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Install a composer contribution that prepares validated input before admission and preserves readable drafts after disable or upgrade.

**Blocked by:** [15 — Preserve composer drafts, recall and stash](15-recoverable-drafts.md), [23 — Preserve active work across plugin lifecycle changes](23-plugin-leased-executions.md)

**Spec coverage:** PC02, PC24, PC25, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Declare contribution schemas and versions through the production loader while keeping provider/backend execution independent of React.
- [ ] Before-admission transforms are side-effect-free by contract and produce validated immutable prepared input. They cannot modify admitted submissions or perform an untracked effect.
- [ ] Crash/disable/upgrade retains plain text and context references for plugin nodes. Unsupported nodes remain readable or prevent sending with an actionable explanation.
- [ ] Capability, attachment and account validation applies to transformed input; the reviewed prepared payload equals the native delivered payload.
- [ ] Activation cleanup and command registration follow existing lifecycle ownership; trusted plugin code is not described as a hostile-code sandbox.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use a real composer contribution in built Electron, compare prepared/native payloads and exercise ownership conflict, invalid transformation, crash and disable recovery.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
