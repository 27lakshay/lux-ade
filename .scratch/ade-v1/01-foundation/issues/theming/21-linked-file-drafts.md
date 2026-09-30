# 21 — Watch linked theme files as drafts

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Explicitly link a theme file and review external edits as drafts without automatically changing saved appearance or running terminals.

**Blocked by:** [18 — Edit complete custom themes](18-advanced-editor.md)

**Spec coverage:** TH24. User stories 63. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria


- [x] Linking requires a deliberate file choice and uses the same supported parser/validation and editor preview as normal import.
- [x] Valid file changes refresh only the local draft. They neither persist/apply a theme nor alter other windows, startup cache or real terminal defaults.
- [x] Partial saves, malformed content, deletion and replacement retain the last usable draft and show source diagnostics.
- [x] Watcher resources and queued changes are bounded; unlinking, closing the editor or window shutdown releases the watcher.
- [x] Saving a watched draft uses current revision checks and existing conflict handling; source files remain unchanged unless a separate explicit export writes them.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Use scratch files with rapid valid/partial/invalid writes, rename and deletion while driving the editor. Query committed state and real terminal colors to prove isolation.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Evidence and blockers

 - The built Electron scratch-profile spec links a chosen JSON file, observes a valid edit in the local preview, proves saved profile appearance and a live terminal's resolved appearance remain unchanged, and proves no theme is installed. Malformed and deleted sources report diagnostics without replacing the last usable draft; atomic replacement and recreation refresh it. Saving the draft leaves the linked file byte-for-byte unchanged; later file edits no longer affect the saved editor draft. Linked update sequences fence the async initial response from newer watcher events.
 - `pnpm --filter @ade/desktop build` and `pnpm --filter @ade/desktop typecheck` passed. `pnpm test:e2e:desktop:only e2e/desktop/theme-linked-file.spec.ts --workers 1` passed (1 test) at `test-results/runs/desktop-d3f31649-0a2b-4bff-9895-205c7a0420c9`.
- The linked-file scenario also passed in the current combined desktop integration (11 tests total) at `test-results/runs/desktop-a3636694-6168-4007-af70-ff17dc489836`. This adds integrated evidence for the existing local-draft and source-preservation criteria; it does not complete ticket 18’s broader consumer acceptance.
- `pnpm check:static` passed for the parent integration at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`.
- The linked-file flow also passed in the final integrated Electron appearance/theme run: 43 tests at `test-results/runs/desktop-5e9d141a-21df-4d67-b5aa-37ceb08eab20`.
