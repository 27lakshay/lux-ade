# 15 — Preserve composer drafts, recall and stash

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Recover unfinished TipTap input after a window crash or rejected send, and transfer, recall or stash it without another view overwriting it.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC06, PC24, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Preserve client-and-conversation draft ownership and revision conflicts through existing daemon/client journal mechanisms; the renderer does not become durable authority.
- [x] Two views keep independent local interaction state. Explicit ownership transfer reports conflicts and preserves the prior recoverable input.
- [x] Crash recovery, recall and stash retain text and context references. Send associates the draft with its admitted intent rather than clearing it into an unrelated retry.
- [x] Failed validation or admission preserves the draft. Uncertain admitted delivery remains linked to that intent and cannot become an automatic duplicate send.
- [x] Provide recoverable plain-text/context serialization for future extension nodes; unsupported input stays readable or sending is refused with an explanation.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Crash/reopen built Electron and race draft ownership through real public operations; verify retained input, revisions and existing send-intent reconciliation.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Most of this slice was already built: per-window daemon drafts with revisions, the SDK send journal and pipeline, stash, recall and transfer. This ticket fixed what the acceptance runs found and closed the remaining criterion.

Fixes:
- A restored admitted prompt stayed open after the window restarted. The composer saw native "accepted" evidence and cleared the prompt locally, but the daemon still listed the intent. A restored attempt is now settled under its own request ID once native acceptance is seen; the daemon answers from its receipt and starts no turn.
- The composer showed Electron's IPC wrapper text ("Error invoking remote method …") in its messages. `messageOf` now uses the shared `hostErrorMessage`.
- Two tests in `e2e/desktop/send.spec.ts` contradicted the code from the same commit: one expected no error after a draft revision conflict, and one expected different recovery wording. The code reports the conflict and keeps a recovery copy, which this ticket requires; the tests now assert that, including that the conflict is visible in the second view.

Decision:
- Context references in a draft travel to the provider as their attachments; the reference itself is kept with the draft, sent intent and history. The desktop editor has no node for any reference kind yet, so the composer now lists each reference readably ("file range: src/app.ts", or the kind and label of a kind it does not know) and keeps it unchanged while the text is edited. Nothing is dropped and nothing is refused.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-aa5fea47-1d1c-49b2-9ca2-485a2df02dff`).
- Built Electron (`test-results/runs/desktop-cf439811-1ca6-4251-92c5-b742dce22652`): all 7 `send.spec.ts` cases pass, including two views fencing a conflicting draft, the admitted intent after an Electron restart (no second turn), the daemon-down refusal and the journaled prompt surviving app and daemon death. New `draft-context.spec.ts`: references survive an app restart, unknown kinds are listed readably, typing keeps them, and the sent history entry carries them. Screenshot `draft-context.png`.
- Real processes: `e2e/protocol/context`, `conversations/drafts.spec.ts`, `conversations/outbox.spec.ts` and `conversations2/draft-history.spec.ts` pass, except `context/compaction.spec.ts` (fails on HEAD; ticket 18) and `context/attachments.spec.ts:120` (large image; ticket 16). `packages/client/src/journals.test.mjs` passes.

Not run: a renderer crash (as opposed to an app kill) with a dirty unsaved draft inside the 250 ms save delay; text typed in that window is not journaled.

2026-10-02 (ticket 32 reconciliation): closed the renderer-crash gap recorded above. The composer no longer waits 250 ms before handing an edit to main: `provisional/latestSave.ts` starts a `draft.save` with each edit when none is in flight and collapses edits made meanwhile to the newest, so main (which survives a renderer crash and saves to the daemon) holds the text as soon as it is typed. Unit test `latestSave.test.ts`; built-desktop `e2e/desktop/draft-crash.spec.ts` locks the renderer in the task after an edit and then crashes it, and the text typed just before is in the daemon's draft. With the old 250 ms delay restored the same test fails (`Received: "Keep the first part"`), and passes with the change (`desktop-9a9c150a-60c1-44ae-9bcc-7791494ce90f`). Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
