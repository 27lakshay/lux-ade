# 14 — Recover uncertain sends and failed executions

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Inspect and reconcile uncertain native delivery or execution after crashes without repeating external effects automatically.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [05 — Stop an identified execution truthfully](05-identified-stop.md)

**Spec coverage:** PC04, PC09, PC15, PC16, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Worker/runtime death after dispatch preserves durable intent/receipts and reports unknown delivery or execution where native evidence is insufficient.
- [ ] Reconcile by stable operation/session identity and trustworthy native evidence. Similar prompt text is not proof of a specific operation outcome.
- [ ] SDK retries, host restart and fiber interruption cannot redispatch an unknown effect. Expected failures, defects, shutdown and intentional interruption retain different sanitized causes.
- [ ] Durable storage failure blocks normal admission and preserves pending input. Existing emergency runtime control can attempt Stop with truthful limited evidence without a competing mutation API.
- [ ] Native resume that may continue interrupted work is disclosed and explicitly requested; read-only inspection/history loading cannot trigger it.
- [ ] Desktop and CLI/SDK offer the same evidence-based recovery actions, refusal reasons and unresolved outcomes.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Crash peers before/after native acceptance, lose replies and fail persistence through existing fault fixtures; inspect receipts and recovery actions in built Electron with zero correctness retries.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
