# 16 — Preview and validate attachments and captured context

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Preview the exact supported context and attachments to be sent, then reject unavailable or stale input before dispatch without losing the draft.

**Blocked by:** [15 — Preserve composer drafts, recall and stash](15-recoverable-drafts.md)

**Spec coverage:** PC06, PC25. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Preview selected supported sources with stable source identity, revision and exact prepared payload, including files, text, terminal output, diffs, browser context and media where those selected sources actually exist.
- [ ] Validate current provider type/count/byte limits, account context and source availability before effect admission. Unsupported content does not produce a native submission.
- [ ] Native input matches the reviewed immutable prepared context; changed sources require explicit recapture or the declared retained snapshot behavior.
- [ ] Context preparation avoids implicit unsupported file restoration or unrelated surface construction. Missing source prerequisites are recorded, not substituted with fake product sources.
- [ ] Rejected preparation/admission preserves draft and attachment references. CLI/SDK and desktop report matching sanitized errors and supported recovery.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Capture available real ADE sources in built desktop and compare native received payloads; race source changes and missing/oversized attachments through protocol fixtures.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
