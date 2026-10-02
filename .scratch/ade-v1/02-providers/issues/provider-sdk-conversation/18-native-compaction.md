# 18 — Compact context with native evidence

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Request supported native compaction and retain readable history with an honest native outcome.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC02, PC19, PC35. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Advertise compaction only with current native support/availability and preserve effect admission, receipt and unknown-outcome behavior.
- [x] Report observed compaction results and affected history revision rather than marking success on request acknowledgement.
- [x] Invalidate or refresh affected snapshots while retaining durable readable content and provenance.
- [x] Repeated tool material after compaction does not become a second execution, and absent call context remains explicitly incomplete.
- [x] Unsupported or failed compaction has the same visible/API meaning and cannot silently submit a replacement prompt.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Exercise native compaction acknowledgement, partial failure, lost reply and repeated history material through real processes and built desktop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Most of this slice existed: `conversation.compact` is an effect command with a receipt, `conversation.controls` advertises it only while the provider supports it now (Codex `thread/compact/start`; Claude and Oh My Pi report it unavailable), an acknowledged reply means only that the provider started, and the provider's `contextCompaction` item is retained as a record after the earlier history. Lost replies, crashes between dispatch and acknowledgement, and a run lost with the runtime are covered by `conversations2/compact.spec.ts`.

Fix:
- The compaction turn's end overwrote the previous prompt's terminal record with the compaction turn's ID, so the prompt appeared to have ended in the compaction (`context/compaction.spec.ts` failed on HEAD for this). A native turn's end now updates a prompt's terminal only when it is that prompt's own native turn.

Desktop (provisional): "Compact context" sits beside the provider settings and is enabled only when the daemon reports compaction available, else it shows the reason. After an acknowledgement it says the provider started and that the result appears in the conversation; a retry after an unconfirmed reply reuses the operation ID.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-ebc4f460-1d46-4e45-9194-fd6fff43ecc9`).
- Real processes: `context/compaction.spec.ts` 3/3 and `conversations2/compact.spec.ts` 4/4; the conversations directory and `reliability-core/stream-fencing.spec.ts` rerun with only `conversations2/lost-turn.spec.ts` failing, as on HEAD.
- Built Electron: `e2e/desktop/compaction.spec.ts` (`test-results/runs/desktop-dd58e76b-2946-44d6-ae3e-69e51d65e72f`): Codex compaction from the window, the native record shown, the earlier prompt's delivery unchanged; Claude shows compaction unavailable with its reason. Screenshot `compaction.png`.

Not covered: a provider that repeats tool material after compaction (no fixture provider does); Claude native compaction (the worker uses none).

2026-10-02 (ticket 32 reconciliation): closed "a provider that repeats tool material after compaction". The Codex mock's `compact-replay-tools` switch repeats earlier `commandExecution` items (same IDs and output) under the compaction turn. That found a defect: the repeated item kept one record but was moved to the compaction turn. The store now keeps the turn that first reported an item (`store/conversations.rs`). `e2e/protocol/context/compaction.spec.ts` "PC35: …" checks one record with its original turn and output, and that a later tool gets only its own output. Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
