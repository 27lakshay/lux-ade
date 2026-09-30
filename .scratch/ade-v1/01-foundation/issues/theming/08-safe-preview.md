# 08 — Preview appearance safely before applying it

Status: in-progress
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Compare app, code, diff and terminal samples locally before committing a selection, with safe cancellation when another window changes appearance.

**Blocked by:** [04 — Choose independent terminal themes and per-terminal overrides](04-terminal-bindings.md), [05 — Render complete terminal cursor and selection colors](05-cursor-selection.md), [07 — Theme code blocks, previews and diffs independently](07-code-diff-themes.md)

**Spec coverage:** TH05. User stories 16–19, 25. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Preview shows both variants and realistic ANSI, truecolor, cursor, selection and diff samples in isolated views.
- [x] Preview may recolor local ADE chrome but changes neither running terminal defaults/query responses nor other windows, durable preferences or the startup cache.
- [x] Apply validates current definition/selection revisions before committing. Conflicts expose retry/rebase instead of silently overwriting newer state.
- [x] Cancel and closing the preview restore the newest committed appearance, including a selection changed from another window or the CLI during preview.
- [x] Persistence failure remains visible and retains the prior committed setting. Keyboard focus and dismissal follow the stock provisional UI patterns.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Use two built-desktop windows plus a real terminal program and CLI mutation during preview. Verify local samples, native queries, saved state and cancellation after both a conflict and a failed save.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.


## Comments

2026-09-29 — Preview work while production code surfaces are absent.

- Ticket 07's independent syntax settings, shared color mappings, startup behavior and real-library adapters have passed their supporting checks. Its production code/preview/diff acceptance remains dependent on the owning conversation and file/review features. Those missing surfaces do not prevent isolated preview samples from using the verified adapters. Work around that blocked portion here; keep the approved blocking edges and ticket 07's open production criteria. This preview is not substitute evidence for TH25.
- Added a stock provisional dialog that edits app light/dark choices and independent terminal/syntax bindings locally. Both mode samples use the exact catalog tokens; the samples use real Shiki, Pierre and Ghostty rendering. Libraries load on demand when preview opens. Palette changes repaint variables/canvas without replacing code or diff content.
- The preview remains scoped inside the dialog. It never calls setTheme on the host, changes document-root tokens, attaches to a real terminal or writes the startup cache. Main and live windows continue following committed changes. Cancel, Escape and close remove the local samples, so no captured obsolete root palette can be restored over a newer selection.
- Added @ade/terminal/preview: a bounded fixed ANSI/truecolor/style/cursor/selection sample with its own production Ghostty core and painter, no bridge or input/query responder. Async sample creation checks disposal before attachment and uses the latest requested palette. Each sample frees its core on close. Terminal bytes remain outside React state.
- Apply sends the complete draft selection in one settings.set call with the captured appearance revision. A stale revision retains the draft and displays the error. Rebase explicitly fetches the latest revision and asks the user to review the retained draft before a second Apply. Typography, readability and unrelated settings are not in this mutation. Current bundled definitions are immutable; custom-definition revision checks remain an integration obligation for ticket 09.
- A scratch SQLite trigger exercises a real persistence failure. The transaction keeps prior settings and the dialog retains the draft/error. Removing the trigger permits the same Apply to succeed without a new guessed revision.
- The initial static runs failed at E2E type annotations and then at repository UI rules (ref access during render, explicit control sizes, stock typography, scroll-area and named sizing tokens). Corrected the code; do not count those failed gates as passing evidence (`/tmp/ade-preview-static.log`, `/tmp/ade-preview-static-final.log`).
- The first built-desktop run passed isolation but found that adding an error could push Cancel outside the viewport. Moved scrolling samples/fields into a bounded ScrollArea, with the footer outside it (`/tmp/ade-preview-desktop.log`). The corrected focused run passed all 3 then-existing tests (`/tmp/ade-preview-desktop-final.log`).
- Screenshot inspection found a separate Tailwind collision: --color-base made stock text-base classes select the base color, making dialog/card titles unreadable. Retained the base token and bg-base semantic fill through an explicit utility, and removed only its ambiguous general color alias. Stock kit components and handed-off colors remain unchanged. Built-desktop assertions check dialog and both sample title colors; the approved workspace still consumes bg-base.
- Extracted the existing PTY appearance query program into a shared protocol fixture. Its existing terminal protocol tests still pass: 13 tests, `/tmp/ade-preview-query-regression.log`. No daemon, contract or native/WASM pin changes occurred.


Final slice evidence:

- pnpm check:static: passed on final source, including 340 renderer tests in 47 files and 863 Rust tests, with 1 existing skip (`/tmp/ade-preview-static-final-source.log`). The intermediate static gates also passed after the lint/layout fixes (`/tmp/ade-preview-static-verified.log`, `/tmp/ade-preview-static-layout.log`, `/tmp/ade-preview-static-complete.log`); final acceptance uses the later run.
- pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-preview.spec.ts: 33 passed (56.5s), `/tmp/ade-preview-desktop-integrated.log`. This runs the existing full appearance suite after the Tailwind utility change and all four new preview tests.
- Two real built-desktop windows retain committed root colors during local preview. The daemon reply and byte-for-byte startup cache remain unchanged. A real PTY program receives exactly one native OSC background reply with Graphite's committed bytes while isolated samples show Linen/Carbon. Runtime instance, real terminal identity, run ID and positive shell PID remain unchanged.
- Stale Apply rejects without mutation, preserves the draft and leaves CLI-selected Ink visible after Cancel. Explicit Rebase retains the draft and permits a subsequent Apply while preserving a newer appearance-mode setting. A fixed Chalk terminal and paired Linen/Ink syntax preview commit together with exactly one appearance revision increment. No sample attaches to the real terminal.
- SQLite-triggered persistence failure leaves the prior settings/revision intact and the visible draft/error available for retry. Removing the trigger permits successful recovery. Actual pointer clicks cover Apply, Cancel and Rebase; Escape closes the dialog and returns keyboard focus to its trigger.
- pnpm --filter @ade/desktop test ../../packages/terminal/src/preview.test.ts: 1 passed (`/tmp/ade-preview-terminal-green.log`). The initial absent-module failure is `/tmp/ade-preview-terminal-red.log`. The same canvas repaints indexed ANSI cells while the truecolor swatch keeps its exact bytes.
- Inspected the actual built-app screenshot at test-results/desktop/appearance-preview-both-mo-ab1a5-e-and-Escape-restores-focus/appearance-preview.png. Both mode cards, real code/diff samples, scrollable terminal samples, corrected title colors and the persistent footer are visible. The screenshot is supporting visual evidence; the real-process tests establish isolation and mutation behavior.
- git diff --check: passed.

Accepted the sample/isolation/cancellation/persistence/focus criteria and evidence-recording criterion. Keep the revision criterion open for custom-definition integration: selection revision conflicts pass today, but ticket 09 has not introduced mutable definitions and their revisions. Ticket 08 remains in progress. This does not close ticket 07, TH25 or any shared TH acceptance row.


2026-09-30 — Custom definitions and authoritative previews:

- Completed the definition-revision criterion through ticket 09. `themes.preview` is a query that resolves both draft variants through the daemon's section resolver and returns the captured definition revisions. `settings.set` checks `expected_theme_revisions` and the captured appearance revision before its transaction. This covers a definition that was previewed but is not selected yet, including an inactive light variant. A changed definition cannot silently replace the colors shown by an existing preview.
- The desktop now adapts the daemon's resolved terminal appearance directly. Removed its separate bundled terminal color resolver. Both built-in and custom previews therefore preserve 256 indexed colors, symbolic cursor/selection policies, selection alpha and saved readability preferences. Unsupported extensions stay inert. Queries change neither selections, native defaults nor the startup cache.
- Library inspection offers only the sections supplied by a definition. Preview and select opens the stock local dialog with that section in the draft; Apply commits the full selection atomically. A definition conflict retains the displayed colors and draft. Explicit Rebase resolves the latest definitions before the next Apply. Preview queries are discarded on close; reopening captures fresh records.
- Accepted evidence: `pnpm test:e2e:desktop:only theme-selection.spec.ts theme-library.spec.ts theme-validation.spec.ts appearance-preview.spec.ts` passed 10 tests in 11.3 seconds (`/tmp/ade-theme-selection-desktop-final-accepted.log`). This includes custom conflict/rebase/cancel, source-file deletion and restart, section-restricted choices, and all four existing preview isolation/recovery tests. `pnpm test:e2e:protocol:only profiles/theme-selection.spec.ts terminals2/custom-theme.spec.ts profiles/theme-library.spec.ts profiles/theme-validation.spec.ts profiles/settings.spec.ts profiles/palettes.spec.ts` passed 23 tests in 17.8 seconds (`/tmp/ade-theme-selection-protocol-accepted.log`), including an inactive-definition conflict without an appearance-revision change.
- The final `pnpm check:static` passed: 341 renderer tests in 47 files, 871 Rust tests with 1 existing skip, generated contracts/API parity, formatting, typecheck, lint, dead-code and boundary checks (`/tmp/ade-theme-selection-static-complete.log`). Ticket 07's production code/file/diff surface prerequisite remains open. All local preview criteria now have evidence; this does not establish production TH25 or close the shared acceptance matrix.
