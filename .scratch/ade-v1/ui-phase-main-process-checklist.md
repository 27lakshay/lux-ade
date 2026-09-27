# UI phase: main-process behaviour to re-prove

Status: open
Type: E2E coverage checklist

The Electron specs in `e2e/specs` drove the old test-harness renderer and were deleted on
2026-09-28, when the renderer was replaced by the new workspace shell. The Electron main process
and preload were kept. The behaviour below was proven only through those specs, so each item needs
a new Electron spec written against the new UI before its row can be accepted.

Tick an item when a spec in the new UI suite proves it. Behaviour already proven headlessly in
`e2e/protocol` is not listed.

## Sends, drafts and journals

`conversations/send-pipeline.ts`, `send-journal.ts`, `outbox-file.ts`

- [ ] A send is journaled before dispatch. A retry reuses the request ID after reload, hidden close, or a SIGKILL at `draft.save`, `draft.send.prepare` or `agent.send` — `dispatchSend`, `reconcileAcceptedSend`, `SendJournal.upsert`
- [ ] A lost prepare or completion reply settles on retry without a second turn — `send-pipeline.ts`
- [ ] A prompt the daemon rejects releases the draft — `send-pipeline.ts`, `conversations/ipc.ts`
- [ ] Per-window drafts persist across reload and clear only after send — `loadDraft`, `scheduleDraft`, `flushDraft`, `persistentWindowId`
- [ ] Typing is not overwritten by a late draft load after switching conversation (renderer behaviour; re-prove in the new composer)
- [ ] Pending-send export and import: 0600 bundle, identity checks, restore hold, one turn on retry — `SendJournal.exportProfile`, `importProfile`, `inspectTransfer`
- [ ] An invalid journal makes the app exit cleanly with no modal dialog — `outbox-file.ts`, `index.ts` `whenReady().catch`

## Quit and close

- [ ] Quit reconciles accepted prompts, including from an inactive profile, and warns once — `conversations/quit-guard.ts` (`draftQuitGuard`, `warnPendingSends`), `quit-coordinator.ts`
- [ ] Closing a window flushes its drafts, or keeps the window open when a save fails — `index.ts` `openMainWindow` close handler

## Context fences, review and Git

`conversations/ipc.ts`, `workspaces.ts`, `review.ts`, `files.ts`, `git-journal.ts`

- [ ] Account, agent and create requests are fenced to the profile generation — `conversations/ipc.ts`
- [ ] `account.verify` checks the identity shape; inspect cannot cross a profile switch — `conversations/ipc.ts`
- [ ] The selection epoch fences delayed review and file reads to the selected workspace — `workspaces.ts` `ade:workspace-select`, `review.ts` `activeReviewContext`, `assertReviewContext`
- [ ] File path and size limits; search continues past the scan budget — `files.ts`
- [ ] A stale diff token blocks feedback; a diff change after journaling blocks the send; ordinary drafts are refused — `review.ts` `reviewPrompt`, `reviewBatchPrompt`
- [ ] Batch review notes and ranges survive reload — was renderer `sessionStorage`; decide where the new UI keeps them
- [ ] Stage and commit touch only the reviewed workspace; a delayed reply stays bound to it — `review.ts`
- [ ] A Git operation ID survives a crash and is read back and acknowledged — `git-journal.ts`, `review.ts` `ade:git-journal-read`, `ade:git-journal-ack`
- [ ] Discard previews first and refuses a newer edit; the staged index is kept — `review.ts`
- [ ] Guided rebind of a restored profile; a wrong path is refused — `workspaces.ts` `ade:restore-bindings`, `ade:restore-binding`

## Browser

`browser.ts`, `browser-owner.ts`

- [ ] Cookies and tabs are isolated per profile and by fixed socket; the lease refuses a second process — `setBrowserProfile`, `acquireBrowserLease`
- [ ] Storage migration recovers from a crash at each of its 6 points; adoption is explicit; a moved home is refused — `migrateBrowserStorage`, `adoptUnownedBrowserStorage`
- [ ] The owner registers and renews on profile switch; a delayed open after a switch fails with "Browser owner changed"; a closed tab cannot be read — `BrowserOwner.register`, `readBrowserOwner`
- [ ] CLI open, navigate and close are idempotent by request ID, and receipts survive relaunch — `mutateBrowserOwner`, `readBrowserOperation`, `reconcileBrowserReceipts`
- [ ] Backup capture fences in-flight operations, writes a 0600 bundle with persistent cookies only, and restore resumes after a failure — `captureBrowserProfile`, `restoreBrowserProfile`
- [ ] Blocked schemes, downloads and permission prompts; closed tab IDs are refused — `openBrowserTab`, `viewFor`

## Profiles, connection, terminals and startup

`profiles.ts`, `profile-connection.ts`, `terminals.ts`, `index.ts`

- [ ] Create and switch profiles without stopping either daemon — `selectProfile`, `profile-connection.ts`
- [ ] Client state is re-sent to the renderer after a reload — `getClient`, `broadcast`
- [ ] A shell and its alternate screen survive a renderer reload; terminals detach on navigation — `terminals.ts` `closeSenderTerminals`
- [ ] Hidden-window launch; `getAppVersion`; an unconfigured state with no profiles — `openMainWindow`, `ade:app-version`

## Left over from the deleted specs

- The main process still reads E2E hooks that no spec sets now: `ADE_E2E_BROWSER_MIGRATION_*`,
  `ADE_E2E_BROWSER_PAUSE*`, `ADE_E2E_BROWSER_RESTORE_FAIL*`, `ADE_E2E_SEND_JOURNAL_*` and
  `ADE_E2E_TEST_CLOSE_GUARD`. Reuse them in the new specs, or remove them.
- `e2e/packaged/macos.spec.ts` and both `e2e/live` specs locate elements in the old renderer. They
  need new selectors before R020 and the live provider checks can run again.
- `notifications.ts` and the browser automation, capture, diagnostics and recording modules were
  never covered by an Electron spec; they have `.test.mjs` unit tests only.
