# 32 — Freeze the authoring contract with complete acceptance coverage

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Give provider authors a documented, tested contract whose complete lifecycle and UI extension behavior has verified acceptance rather than types alone.

**Blocked by:** [26 — Recover from thrown and frozen UI extensions](26-extension-safe-mode.md), [29 — Preserve reading position and accessible interaction](29-accessible-reading.md), [30 — Keep conversations and control responsive under load](30-responsive-under-load.md), [31 — Verify native fidelity and publish provider conformance evidence](31-native-conformance-evidence.md)

**Spec coverage:** PC01, PC02, PC03, PC04, PC05, PC06, PC07, PC08, PC09, PC10, PC11, PC12, PC13, PC14, PC15, PC16, PC17, PC18, PC19, PC20, PC21, PC22, PC23, PC24, PC25, PC26, PC27, PC28, PC29, PC30, PC31, PC32, PC33, PC34, PC35, PC36, PC37, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Reconcile all PC01–PC38 contributions and all 78 user stories against evidence from the completed tickets; a covered row is not accepted until every required contributing behavior passes.
- [ ] Publish authoring guidance for capabilities, tiers, admission, ordering, identities, settings, requests, cancellation, reconciliation, history consistency, scopes, framing and independent packaging.
- [ ] Document the small Effect service/lifetime conventions, generated Rust-owned authority, exact compatible package set and agent resources; preserve explicit limits for optional AI/MCP/observability dependencies.
- [ ] Verify core-readable history and backend/UI separation with independently installed timeline/composer contributions, missing renderers and safe-mode recovery.
- [ ] Record measured resource policy, installed/live prerequisites and any remaining limitations without claiming unsupported parity or exact-once external execution.
- [ ] Do not freeze while mandatory acceptance gaps remain. Preserve existing feature dispositions and earlier evidence, updating delivery acceptance only for the behavior actually proven.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Reconcile reports from all contributing tickets and run the applicable full ordinary/integration gates against the final artifact. Freeze requires documentation and evidence review, not only a successful typecheck.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
