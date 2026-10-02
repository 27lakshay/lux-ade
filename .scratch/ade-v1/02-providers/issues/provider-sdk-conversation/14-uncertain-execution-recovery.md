# 14 — Recover uncertain sends and failed executions

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Inspect and reconcile uncertain native delivery or execution after crashes without repeating external effects automatically.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [05 — Stop an identified execution truthfully](05-identified-stop.md)

**Spec coverage:** PC04, PC09, PC15, PC16, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Worker/runtime death after dispatch preserves durable intent/receipts and reports unknown delivery or execution where native evidence is insufficient.
- [x] Reconcile by stable operation/session identity and trustworthy native evidence. Similar prompt text is not proof of a specific operation outcome.
- [x] SDK retries, host restart and fiber interruption cannot redispatch an unknown effect. Expected failures, defects, shutdown and intentional interruption retain different sanitized causes.
- [x] Durable storage failure blocks normal admission and preserves pending input. Existing emergency runtime control can attempt Stop with truthful limited evidence without a competing mutation API.
- [x] Native resume that may continue interrupted work is disclosed and explicitly requested; read-only inspection/history loading cannot trigger it.
- [x] Desktop and CLI/SDK offer the same evidence-based recovery actions, refusal reasons and unresolved outcomes.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Crash peers before/after native acceptance, lose replies and fail persistence through existing fault fixtures; inspect receipts and recovery actions in built Electron with zero correctness retries.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Most of this slice existed: durable send intents and receipts, `operation_unknown` delivery after a lost provider, runtime restart reconciliation (settled, quarantined, unknown) with `runtime.recovery` and release, deduplicated retries under the same request ID, a full-disk refusal with a still-working Stop, and reads that never open a provider. Reconciliation matches by request, operation and native identity; text comparisons only guard integrity beside a stable ID.

Decisions and changes:
- Native resume is disclosed. When the newest prompt's native outcome is unknown and no Agent is connected, `agent.resume` is refused with the prompt's request ID and the reason: reopening its native session may continue that work. `continue_interrupted: true` (CLI `conversation resume ID --continue-interrupted`) resumes anyway. ADE never resends the prompt either way. A prompt the provider accepted but whose run was lost resumes without the flag, as before (the native session does not continue it on its own).
- Desktop parity (provisional "Conversation recovery"): a stopped conversation offers Resume; the daemon's refusal is shown, and only "Resume and let the session continue that work" sends the explicit flag. Unresolved runtime attempts for this conversation are listed with the daemon's classification and evidence; an `unknown` attempt can be accepted as stopped (`runtime.recovery.release`, which main allows only for this conversation's own attempt).
- Failure causes: the provider SDK keeps a typed expected failure (its own code), a defect (`integration_bug`) and an interrupted handler (`cancelled`) apart, and writes no reply for a request still pending at shutdown, which the host reads as a closed transport and an unknown outcome. A new SDK test pins this down. No code change was needed there.
- Test fixture: the Codex mock gains a `hang-turn-reply` marker that never answers `turn/start`, so a test can end the provider before its acceptance is known.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-6fa55337-dfab-4abd-a566-deeac5469f46`).
- Real processes: new `conversations/interrupted-resume.spec.ts` (provider killed before acceptance → `unknown`; SDK and CLI refuse an implicit resume naming the prompt; explicit resume succeeds; one `turn/start`); new case in `plugins/provider-sdk.spec.ts` (expected, defect, interrupt and shutdown causes). Every protocol spec that calls `agent.resume` was rerun: only failures that also fail on HEAD remained (plugin, descendant, lost-turn, delete), plus `recovery/runtime-crash.spec.ts:40`, which passed on rerun.
- Built Electron: `e2e/desktop/recovery.spec.ts` (`test-results/runs/desktop-8a3d2920-7104-4dfd-8e7e-cb884d0dadeb`), screenshot `recovery-refused.png`.

Not covered: a test that a refused prompt's draft survives a full disk (the existing R004 spec covers the refusal and the Stop); the desktop "Reconcile delivery" still completes the draft once the daemon admitted the prompt, while the message keeps showing an unknown native outcome; and active native-evidence lookup (asking the provider whether it holds the prompt) is not implemented for any provider.

2026-10-02 (ticket 32 reconciliation): fixed the `lost-turn.spec.ts` daemon-survives failure present since 48949704. A lost run was committed twice: first as an ordinary interruption, then as a lost run that then saw no state change, so `operation_unknown` was never recorded. It is now one lost-run commit carrying the delivery records (`sessions/agents.rs`, `store/conversations.rs::commit_lost_run`). Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
