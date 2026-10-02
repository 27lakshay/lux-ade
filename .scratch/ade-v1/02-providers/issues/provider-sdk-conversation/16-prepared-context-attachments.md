# 16 — Preview and validate attachments and captured context

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Preview the exact supported context and attachments to be sent, then reject unavailable or stale input before dispatch without losing the draft.

**Blocked by:** [15 — Preserve composer drafts, recall and stash](15-recoverable-drafts.md)

**Spec coverage:** PC06, PC25. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Preview selected supported sources with stable source identity, revision and exact prepared payload, including files, text, terminal output, diffs, browser context and media where those selected sources actually exist.
- [x] Validate current provider type/count/byte limits, account context and source availability before effect admission. Unsupported content does not produce a native submission.
- [x] Native input matches the reviewed immutable prepared context; changed sources require explicit recapture or the declared retained snapshot behavior.
- [x] Context preparation avoids implicit unsupported file restoration or unrelated surface construction. Missing source prerequisites are recorded, not substituted with fake product sources.
- [x] Rejected preparation/admission preserves draft and attachment references. CLI/SDK and desktop report matching sanitized errors and supported recovery.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Capture available real ADE sources in built desktop and compare native received payloads; race source changes and missing/oversized attachments through protocol fixtures.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Decisions and fixes:
- A prompt carrying ADE's own maximum of attachments (8 MiB per prompt, about 10.7 MiB base64) broke the provider connection: the provider SDK input frame was 1 MiB, the Codex worker and native client 1 MiB, and the shared JSON budget capped one value at 4 MiB. Input frames are now 16 MiB at every hop (SDK `MAX_INPUT_FRAME_BYTES`, Codex worker, native client, runtime host bound, contract schema maximum). Native output keeps its own, unchanged budget; worker requests are scanned with a new `json_budget::within_request_budget`.
- The runtime refuses, before writing, a prompt larger than the worker's declared input frame ("Nothing was sent"), so a worker with a smaller declared limit refuses the prompt instead of losing its transport.
- Desktop: the composer gets "Attach files" (native file dialog in main; each file is imported through `attachment.import`, which checks type and size; a refused file leaves the draft unchanged) and "Remove". Each attachment is listed with the form the provider will receive, or "Will be refused: <reason>", from the daemon's `context.plan` before sending. A send the daemon refuses before admission now shows "This prompt was not sent. <reason>" with "Edit or retry prompt", keeping text and attachments. Before, it showed "Delivery is unknown" and offered reconciliation for a prompt that was never admitted.
- CLI: `conversation send ID TEXT --attach ATTACHMENT_ID` (repeatable) sends imported attachments through the same journaled path. The CLI, SDK and desktop report the same daemon refusal text.
- Context sources: attachments are stored immutably with digests and plans name exact attachment IDs, so the reviewed payload is the dispatched payload. Captured context keeps its capture-time document (existing F033 behaviour); no source is restored implicitly.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-9aa480dc-3f33-49cb-8557-66560765338d`). New unit tests: `json_budget::request_budget_tests`, `provider::worker::tests::a_prompt_past_the_declared_input_frame_is_refused_before_writing`, renderer "a send the daemon refused before admission is editable, never an unknown delivery".
- Real processes: `e2e/protocol/context/attachments.spec.ts` 4/4, including the 7.6 MB Codex image reaching Codex as a data URL and the new CLI case (refusal text matches the SDK; nothing held; an admissible text file reaches Claude once).
- Built Electron: `e2e/desktop/attachments.spec.ts` (unsupported PDF refused at import; text file previewed as a text block; 7.6 MB image previewed as refused for Claude; Send refused before dispatch with draft and attachments kept; after removal the prompt reaches Claude once). Screenshot `attachment-preview.png`.
- Full runs after this ticket: protocol 1057 passed, 33 failed (`test-results/runs/protocol-322e5fda-b0ac-4c2d-a378-8fc695bb098d`); desktop 105 passed, 1 failed (`test-results/runs/desktop-6dc6623f-f710-4fcf-841b-590488644b0f`, the then-unbuilt ticket 13 view). No failure is in an attachment or send path.

Not covered: browser, terminal and diff sources in the desktop composer (those panes are unbuilt); a desktop preview for captured context nodes beyond their readable listing (ticket 15).

2026-10-02 (ticket 32 reconciliation): closed the captured-context preview gap. A draft reference that names a daemon context node (`data.node_id`) now offers "Preview what the provider receives" (`provisional/DraftContext.tsx`, through a new renderer route for `context.get`): the source identity (path, captured lines and source line count, who read it, SHA-256 prefix, any cut) and the exact document, with the plan's text prefix. `e2e/desktop/draft-context.spec.ts` captures `src/app.ts` lines 2–4, shows the preview, sends, and checks Codex received exactly the previewed text. Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
