# 05 — Render complete terminal cursor and selection colors

Status: done
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Select text and use a block cursor with theme-defined foreground/background colors that remain correct over shaped and reversed terminal cells.

**Blocked by:** [01 — Switch Graphite and Chalk across the app and terminal](01-core-switch.md)

**Spec coverage:** TH12. User stories 31–33, 43. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Cursor text and selection foreground/background participate in resolved terminal appearance and reach all views. Selection ranges remain local to their views.
- [x] Supported literal and cell-relative values resolve against the correct underlying cell after reverse-video handling.
- [x] Cursor and selected text preserve glyph geometry for wide characters, combining marks and ligatures on ANSI and truecolor cells.
- [x] Changing colors repaints existing content without reconstructing the terminal, modifying output or losing selection/scroll.
- [x] An actual desktop terminal exposes each supported policy using controlled theme values; invalid values fail at validation.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Run a real terminal fixture producing shaped, wide and reversed cells. Verify the Canvas result in renderer tests and the built desktop, including selection and cursor movement.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.


## Comments

2026-09-29 — Started cursor and selection rendering work.

- Inspection found that block cursors repaint an isolated character with a one-cell maximum width, unlike the underlying shaped text run. Repainting now clips the original complete run at its original origin and maximum width. A wide cell receives a two-cell cursor, including when the cursor addresses its spacer tail. Invisible text stays invisible.
- The existing renderer regression was strengthened to require original-run repainting; it failed before implementation and passed afterward. Added five real Chromium Canvas comparisons against normal full-run rendering in the cursor colors. They cover each column of text containing adjacent characters, a wide glyph and a combining sequence, verify pixels outside the cursor remain unchanged, and require actual glyph pixels within it.
- The first pixel test incorrectly assumed white-on-black and black-on-white antialiasing were arithmetic inverses. Chromium disproved that assumption. The test now compares with normal full-run painting in the same colors, without loosening pixel equality. An initial test command also used an incorrect relative file filter; the corrected command below found and ran the tests.
- `pnpm --filter @ade/desktop test ../../packages/terminal/src/ghostty/renderer.test.ts`: 13 passed. Logs: `/tmp/ade-cursor-geometry-red.log`, `/tmp/ade-cursor-geometry-green.log`, `/tmp/ade-cursor-geometry-pixels.log`.
- Full `pnpm check:static` passed, including 317 renderer tests and 863 Rust tests (1 existing skip); log `/tmp/ade-ticket05-cursor-static.log`. `git diff --check` passed. No ticket criterion or TH12 is accepted by this preparatory renderer change.
- Remaining work: typed literal/cell-relative policies, resolved appearance and propagation, selection foreground/background repainting, actual ligature-font coverage, reverse-video cases, validation and built-desktop controls/evidence. The current Ghostty reference documents cell-foreground/cell-background for cursor text and selection colors: https://ghostty.org/docs/config/reference. ADE's core already resolves inverse-video cell colors before handing them to the renderer; policy resolution must consume those resolved cells.

- Rebuilt the desktop with `pnpm --filter @ade/desktop build`. `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts --grep 'changing terminal colors preserves|terminal binding controls|one terminal override'` passed 3 tests (3.9s), covering selection/scroll preservation and live binding controls against the updated renderer. Logs: `/tmp/ade-ticket05-cursor-build.log`, `/tmp/ade-ticket05-cursor-desktop.log`. These are regression checks, not complete TH12 evidence.


2026-09-29 — Color policies and resolved appearance propagation.

- Added renderer cursorText and selectionForeground policies supporting literal RGB, cell-foreground and cell-background. Selection backgrounds also resolve per-cell values, with background-run grouping considering the resolved selection color. The existing CSS background fallback remains internal to initial surface setup; daemon appearance supplies normalized colors.
- Selected text is painted once per clipped color region using the original full shaped run. It is not overpainted on an existing glyph, which would leave antialiased edges in the old color. Text decorations follow selection foreground as well. Surface theme updates forward the policies and request a full repaint.
- Added TerminalColor and CellColor to the Rust appearance contract. Resolved terminal appearance carries cursor_text, selection_foreground and selection_background through the existing runtime projection, ordered appearance frames and snapshots. Generated contracts remain derived from Rust. Feed adaptation maps the public snake_case fields to renderer properties.
- Built-in defaults use the exact terminal-selection handoff value, the terminal background for cursor text and cell-foreground for selected text. This preserves literal ANSI/truecolor foregrounds. No handed-off token changed.
- New pixel tests initially failed on ignored literal text policies. After implementation, all 17 focused renderer tests passed, including exact per-cell foreground-derived/background-derived selection colors. Logs: `/tmp/ade-selection-policy-red.log`, `/tmp/ade-selection-policy-green.log`, `/tmp/ade-selection-policy-pixels.log`.
- Real-process acceptance first failed because resolved appearance lacked the new fields. The first post-implementation run then exposed an incorrect test frame name (terminal_snapshot instead of the contract's snapshot); corrected the test to inspect the actual attachment frame. The test proves Chalk values, a live Graphite update and a replacement-daemon recovery snapshot.
- Extended the built-desktop selection/scroll test to count exact approved selection-background pixels before and after switching dark to light, while retaining the existing selection, scroll and process/output identity assertions.
- Interim static runs caught redundant string unions and use of findLast outside the test TypeScript target. Simplified the union and used reverse/find on a copied frame list. Neither fix suppresses validation or changes assertions.
- Backend and generated contracts rebuilt. The complete real-process appearance protocol set passed 25 tests (6.1s), including terminal appearance/recovery and profile settings, palettes, system appearance and recovery: `/tmp/ade-policy-protocol-verified.log`.
- Remaining work still includes user-selectable controlled policies and their validation, actual ligature-font coverage, explicit reverse-video rendering acceptance, and full TH12 reconciliation. This is incomplete ticket 05 work; no acceptance checkbox is closed.


Final validation for the resolved-policy slice:

- `pnpm check:static`: passed on the final code and tests, including 321 renderer tests and 863 Rust tests, with 1 existing skip. Log: `/tmp/ade-policy-static-verified.log`. An earlier full pass was `/tmp/ade-policy-contract-static.log`; the final run includes the last protocol frame-name correction and desktop selection-pixel assertion.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts`: 25 passed (6.1s), `/tmp/ade-policy-protocol-verified.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts`: 23 passed (44.4s), `/tmp/ade-policy-desktop-verified.log`. Desktop rebuilt after contract/feed changes, `/tmp/ade-policy-contract-desktop-build.log`.
- `git diff --check`: passed. Ticket 05 and TH12 remain open for the remaining criteria above.


2026-09-29 — Profile overrides and desktop controls.

- Added `terminal_color_overrides` to profile settings, public settings.set, CLI JSON settings input and the typed Electron settings bridge. Each of cursor_text, selection_foreground and selection_background accepts a literal RGB value or cell-foreground/cell-background. Omitted roles use the selected theme; an empty object resets all three. Explicit profile overrides apply after the selected palette for profile-following and independently bound terminal records.
- The existing appearance revision covers these edits. Storage commits the overrides and revision atomically, rejects stale edits, preserves the revision for an unchanged save, propagates through the complete runtime projection and includes overrides in core appearance reset.
- Stock provisional controls edit all three roles locally and apply together. Each offers Theme value, Cell foreground, Cell background and Custom color; the custom choice uses a native color input. The UI uses the existing settings mutation error and refresh behavior.
- Rust contract generation initially rejected different request/reply schemas for the shared optional-field object. Omitted roles now serialize as omitted on both sides, yielding one consistent generated contract and canonical empty defaults. RGB objects reject unknown members; out-of-range channels, fractions, unsupported strings and unknown override roles fail before mutation.
- The new protocol test first failed on the unsupported setting. After implementation it proves persistence, CLI reset, revision conflicts, idempotence, invalid input and matching initial overrides in two real WASM views. The settings fixtures now include the new default empty override object.
- The built-desktop test drives real selectors/color inputs, applies literal cursor text and selection background with cell-relative selection foreground, verifies literal pixels on the actual terminal Canvas, and resets through the controls. Its first runs failed because the fixture had not opened a terminal pane; it now opens a terminal before inspecting the canvas. The test then passed (1 test, 2.0s; `/tmp/ade-color-controls-green.log`). The earlier absent-canvas failures are not evidence that controls were exercised.
- An intermediate static gate found the new stock button lacked the required explicit size. Added size=sm. The intermediate full gate passed 321 renderer tests and 863 Rust tests, with 1 existing skip (`/tmp/ade-color-overrides-static.log`). Final integrated validation follows after the stricter RGB validation and last test additions.
- Full ticket acceptance remains open for the remaining glyph-font and reverse-video tests and criterion reconciliation. No parent-spec or shared TH acceptance status changed.


Final validation for profile color overrides:

- `pnpm check:static`: passed, including 321 renderer tests and 863 Rust tests (1 existing skip). Log: `/tmp/ade-color-overrides-static-final.log`.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts`: 26 passed (14.1s). Log: `/tmp/ade-color-overrides-protocol-final.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts`: 24 passed (51.2s). Log: `/tmp/ade-color-overrides-desktop-final.log`.
- `pnpm build:backend` and `pnpm build` passed before E2E; logs `/tmp/ade-color-overrides-backend-final.log` and `/tmp/ade-color-overrides-app-final.log`. `git diff --check` passed.
- Ticket 05 remains in progress. Next: actual shipped-font ligature coverage, explicit reverse-video/cell-relative rendering acceptance, and complete criterion reconciliation.


2026-09-29 — Real Ghostty width metadata, shipped-font shaping and reverse video.

- The acceptance audit found that the adapter read width metadata only for empty cells. Real wide glyphs therefore reported a narrow leading cell, despite the synthetic renderer fixtures carrying a wide marker. Updated the existing core regression to require real wide metadata; it failed before the fix. The adapter now reads the pinned raw-cell width for every cell. The corrected real-core test and renderer tests pass (`/tmp/ade-wide-core-red.log`, `/tmp/ade-wide-core-green.log`).
- Added Chromium rendering tests that feed actual Ghostty cells into the production renderer and load the same pinned JetBrains Mono font already shipped by the desktop. The terminal package declares that existing font version as a test dependency. The tests require the font to load and prove that the sample's whole-run pixels differ from separately drawn characters, so fallback or non-ligating text cannot satisfy the ligature assertion.
- Pixel comparisons cover cursor and selection recoloring through an actual ligature, both cells of a real wide glyph with adjacent combining text, and cell-relative cursor/selection colors after Ghostty resolves reverse video. The reference paints the complete unchanged glyph run with the expected colors. All five tests pass (`/tmp/ade-real-glyph-rendering-final.log`). The first cursor test used a relative movement at a pending wrap boundary; switched to an absolute column and asserted the cursor position before comparing pixels.
- The real built-desktop fixture now emits reversed ANSI text, a wide character, a combining mark and a ligature candidate in one terminal before verifying the configured cursor and selection colors. The existing selection/scroll test still requires unchanged selected text, scroll and runtime process/output identity across color changes.
- Added explicit selection isolation to the two-view protocol case: one view selects text, while the other stays unselected despite receiving identical appearance policies. Targeted acceptance passed (1 test, 1.8s; `/tmp/ade-selection-isolation.log`).
- Rebuilt the desktop (`/tmp/ade-glyph-desktop-build.log`). The full appearance protocol suite passed 26 tests (5.8s; `/tmp/ade-ticket05-protocol-verified.log`). The full built-desktop/development-server suite passed 24 tests (47.5s; `/tmp/ade-ticket05-desktop-verified.log`). A full static pass succeeded before the final two test additions; the final exact-state gate is recorded below when complete.


Ticket 05 acceptance reconciliation:

1. Resolved cursor/selection policies reach live frames and recovery snapshots; the two-view protocol test verifies shared appearance and local selections.
2. Literal and cell-relative values are typed and validated. Real Ghostty reverse-video cells feed exact pixel assertions for the resulting cursor and selection colors.
3. Shipped-font tests prove ligature shaping, and real wide-cell tests compare both cursor and selection glyph coverage. Combining sequences pass through the real core and are present in the built terminal fixture.
4. The built selection/scroll test checks repainting existing content with unchanged selected text, scroll, run IDs, shell PIDs and output byte count. Color updates reuse the existing terminal/core.
5. Desktop controls expose all supported policies, apply controlled values through the real daemon and render literal pixels. Public negative tests reject unsupported strings, channels, alpha and unknown roles; stale edits and reset are covered.
6. Final `pnpm check:static` passed 326 renderer tests and 863 Rust tests (1 existing skip), `/tmp/ade-ticket05-static-final.log`. The complete protocol and desktop results and the final selection-isolation addition are recorded above. `git diff --check` passed.

All ticket criteria are accepted. TH12 remains unverified in the shared index until the planned final acceptance-matrix reconciliation; this ticket now supplies its complete evidence. No parent-spec scope changed. Proceed to ticket 06; ticket 07 is also eligible.
