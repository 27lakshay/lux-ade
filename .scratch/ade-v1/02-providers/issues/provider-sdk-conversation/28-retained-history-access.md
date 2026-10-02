# 28 — Retain access to history after provider removal

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Read, search, export and back up retained conversations when their provider is removed or unavailable, without claiming unsupported execution continuity.

**Blocked by:** [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC17, PC22, PC29. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Retained core envelopes and registered blobs remain readable without native executable, credentials or custom renderers.
- [ ] Integrate existing search/export/backup paths with the new content and history boundaries; do not duplicate stores or broaden unrelated backup scope.
- [ ] Imported or restored histories disclose whether native resume is supported and retain lineage/source identity; readability alone cannot authorize native execution.
- [ ] Exports and backups disclose missing, expired, native-private or unregistered plugin data. Current-format restore follows D19 without prelaunch compatibility shims.
- [ ] Inspect and export bounded retained content through public APIs and desktop controls with explicit unavailable/missing distinctions.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Remove or make unavailable a provider, then read/search/export and round-trip registered retained data through real processes and built desktop; assert omitted-data disclosure.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
