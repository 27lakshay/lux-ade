# 23 — Preserve active work across plugin lifecycle changes

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Update, disable or clean up provider plugins without replacing active leased execution code or removing a successor’s registrations.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC02, PC21, PC28, PC36. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Pin artifact, activation, wire, extension and native data/resume versions separately and expose relevant identity through public inspection.
- [ ] A compatible update leaves active executions leased to the old artifact and starts new work with the new artifact; lease cleanup cannot unregister the successor.
- [ ] Bound shutdown and registration cleanup and fence late callbacks. Author callbacks do not run inside registry locks or storage transactions.
- [ ] Reject incompatible active data/contract combinations before use or require an explicit truthful drain. D19 allows no legacy aliases, dual protocol or development-schema migration shim.
- [ ] Disable and view detach disclose consequences separately; retained core history stays readable and native work is preserved or stopped only under declared lifecycle policy.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Update/disable real installed workers during active turns and pending callbacks; compare artifacts and outcomes in public APIs and built desktop, including rejected breaking changes.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
