# 24 — Render namespaced timeline content with a core fallback

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Install a typed timeline contribution and declared actions while preserving canonical readable history when its renderer is missing or fails.

**Blocked by:** [23 — Preserve active work across plugin lifecycle changes](23-plugin-leased-executions.md)

**Spec coverage:** PC02, PC03, PC22, PC29, PC33. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Separate backend and UI entry points. The provider SDK remains React/Electron-independent and headless installation never loads UI modules.
- [ ] Namespaced events/actions declare IDs, versions, schemas, tiers, limits and core summaries. Validate extension invocation through existing application admission.
- [ ] Load timeline renderers through the production activation-owned registry, using existing command and resource-link conventions rather than a second plugin lifecycle.
- [ ] Retain stable canonical content and blob provenance independently of render transforms. Large custom payloads remain bounded and core-readable.
- [ ] Missing or throwing renderers fall back locally without hiding tools, files/diffs or retained data; departing registration cleanup cannot remove an updated contribution.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Install a real contribution against deterministic provider events, invoke actions through public contracts and verify normal/missing/thrown rendering and headless operation.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
