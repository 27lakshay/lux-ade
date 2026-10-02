# 21 — Install a real fourth provider without core changes

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Install an independently packaged real additional provider and use it for a native turn, retained history and honest failure/recovery without patching ADE core.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC01, PC02, PC15, PC17, PC20, PC30, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Use a genuine additional integration, with OpenCode recommended; renaming a fixture or wrapping an existing primary provider does not satisfy this ticket.
- [ ] Package native dependencies and the compatible Effect runtime through normal plugin installation. No privileged bundled-only operation or source edit in ADE core is needed.
- [ ] Complete send/text/tools and supported history through the public contract, with declared unsupported requests, cancellation and optional operations rather than fabricated parity.
- [ ] Exercise unavailable native installation, accepted-input worker failure and restart/recovery with explicit outcomes and no implicit prompt resubmission.
- [ ] Demonstrate one authoring path across offered Effect/Promise/AsyncIterable interfaces, including typed errors, disposal and cancellation evidence; pass scoped diagnostics and conformance.
- [ ] Record real installed-provider and authenticated live evidence separately from fixtures, with artifact digest, native version, account context and capability matrix.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Install the real packaged artifact into a scratch profile, exercise public operations and the built desktop, and run its native evidence with explicit credentials/prerequisites.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
