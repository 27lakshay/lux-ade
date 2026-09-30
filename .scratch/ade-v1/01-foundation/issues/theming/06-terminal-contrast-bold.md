# 06 — Control terminal contrast and bold-color behavior

Status: done
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Choose terminal fidelity or an explicit readability policy, with predictable bold and bright-palette behavior.

**Blocked by:** [05 — Render complete terminal cursor and selection colors](05-cursor-selection.md)

**Spec coverage:** TH17, TH26. User stories 44, 73. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Terminal contrast correction defaults off and exposes an opt-in floor separately from the stored source palette.
- [x] Bold-color and bright-palette settings have documented precedence and visibly affect relevant terminal cells.
- [x] Policy changes preserve stored PTY bytes, literal source colors and native query values; the UI explains that correction changes rendered colors.
- [x] Policies persist through public settings operations and apply consistently across views without changing fonts or app palette.
- [x] Color imports cannot implicitly replace readability preferences; unsupported imported policies receive diagnostics.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Compare visible cells with native color queries before and after policy changes, including fidelity mode, truecolor and bold text. Prove persistence through daemon operations and desktop relaunch.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.


## Comments

2026-09-29 — Started the renderer contrast slice after ticket 05 acceptance.

- Checked Culori's official API reference and source repository (https://culorijs.org/api/ and https://github.com/Evercoder/culori); use the existing pinned 4.0.2 library for WCAG contrast, RGB interpolation and alpha compositing. Added that version and its existing type version to the terminal package, and removed the unused-dependency exemption now that the library has a consumer.
- Checked Ghostty's minimum-contrast reference (https://ghostty.org/docs/config/reference): ratios span 1–21 and apply to text colors. ADE continues to default to fidelity/off as the approved spec requires.
- Added an optional renderer-only contrast floor. Normal text, selected text/decorations and block-cursor text are corrected against their actual painted backgrounds. Selection alpha is composited before contrast measurement. A per-paint cache avoids repeating the color search for recurring color pairs and is discarded after painting.
- Correction interpolates foreground toward the black/white endpoint with the stronger available contrast, checking rounded byte values during the search. Backgrounds and source colors remain untouched. If the requested floor exceeds what either endpoint can achieve against a fixed background, the strongest endpoint is used; the future controls must explain this limitation rather than claim an impossible guarantee.
- The real Ghostty/Chromium test failed before implementation because the renderer ignored the policy. It now checks fidelity, correction and return to fidelity while requiring unchanged source cells. Known cases require 117 gray against black and 118 gray against white at 4.5, and white against black at 21. These catch rounding below the requested threshold. All eight tests in the real rendering file passed (`/tmp/ade-contrast-red.log`, `/tmp/ade-contrast-green.log`, `/tmp/ade-contrast-rounding.log`).
- This is a preparatory renderer slice. No durable preference, desktop contrast control, native-query acceptance, bold/bright policy or import diagnostics is claimed yet. All ticket criteria and shared TH rows remain open.


Renderer-slice validation:

- `pnpm check:static`: passed, including 329 renderer tests and 863 Rust tests, with 1 existing skip. Log: `/tmp/ade-ticket06-renderer-static.log`.
- `pnpm --filter @ade/desktop build`: passed, `/tmp/ade-contrast-desktop-build.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts --grep 'changing terminal colors preserves|terminal color controls'`: 2 passed (3.0s), `/tmp/ade-contrast-desktop-regression.log`. These check unchanged fidelity behavior in the rebuilt app; the contrast preference is not yet available there.
- `git diff --check`: passed. Next: durable renderer policies, controls and native-query/source-state evidence, followed by bold/bright behavior and import-policy diagnostics in the relevant importer slices.


2026-09-29 — Durable contrast preference and desktop control.

- Added terminal_minimum_contrast to profile settings with a default of 1 (fidelity) and a finite numeric range of 1–21. Decimal ratios are supported. The setting participates in appearance revision conflicts, atomic persistence, complete terminal projection and core appearance reset. Independently bound terminals receive the same profile policy.
- Resolved terminal appearance carries minimum_contrast; ordered live frames and recovery snapshots map it to the surface's renderer-only minimumContrast option. Native RGB defaults and indexed palettes remain unchanged. Floating-point-containing state uses PartialEq instead of Eq; public validation excludes non-finite/out-of-range ratios.
- The first generated-contract attempt exposed schemars' unsupported double format. Followed the existing layout contract convention, using serde_json::Number for the schema, while retaining Rust f64 and explicit bounds. A custom optional-field deserializer rejects explicit null while allowing omission. Generated SDK validation and daemon validation reject invalid ratios before mutation.
- Added named CLI settings parsing and typed Electron forwarding. Stock desktop controls explain fidelity, rendered-only correction, unchanged queries/source colors and unattainable ratios on fixed backgrounds. Invalid input disables Apply; applying or resetting uses the existing revision-checked settings mutation.
- The protocol test first failed on the absent resolved field. It now verifies the default, persistence, CLI reset, invalid input, unchanged palette data, the policy in a real attachment snapshot and unchanged WASM source foreground. An actual PTY program issues OSC queries while correction is enabled and receives the original Graphite foreground.
- A built-desktop test prints black-on-black truecolor text, applies ratio 21 through the controls, finds white glyph pixels without adding PTY output, and returns to fidelity. It requires unchanged run IDs, shell PIDs, terminal byte counts, palette data and app tokens. It also rejects ratio 22 in the UI.
- Initial targeted validation passed 19 protocol tests (`/tmp/ade-contrast-policy-protocol.log`) and the new desktop test (`/tmp/ade-contrast-controls.log`). The initial static gate passed before the last test additions (`/tmp/ade-contrast-policy-static.log`). Final integrated runs are recorded below when complete.
- Bold/bright behavior, contrast behavior across all relevant selected/cursor edge cases, and importer preference/diagnostic acceptance remain outstanding. Ticket 06 is not complete.


Final validation for the durable contrast slice:

- `pnpm check:static`: passed, including 329 renderer tests and 863 Rust tests (1 existing skip). Log: `/tmp/ade-contrast-policy-static-final.log`.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts`: 27 passed (8.9s). Log: `/tmp/ade-contrast-policy-protocol-final.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts`: 25 passed (1.0m). Log: `/tmp/ade-contrast-policy-desktop-final.log`.
- Backend, CLI and desktop rebuilt before E2E; logs `/tmp/ade-contrast-backend.log`, `/tmp/ade-contrast-cli-build.log`, `/tmp/ade-contrast-app-build.log`. `git diff --check` passed.
- Ticket 06 and shared acceptance remain open. Next work is bold/bright policy, then the remaining contrast edge cases and importer integration evidence.


2026-09-29 — Bold provenance and renderer precedence.

- Inspected the pinned Ghostty headers under `.ade/vendor/libghostty-vt/include/ghostty/vt/`: style.h exposes the original foreground tag and palette index, while render.h explicitly leaves bold-color handling to the caller and exposes the active palette as render-state field 9. Struct and union offsets come from the WASM type manifest.
- The core now retains bold-cell source colors, inverse/faint flags and the active bright counterpart only for palette indexes 0–7. It reads the active palette including OSC overrides into a per-core allocation released on disposal. It never guesses an index from equal RGB bytes.
- A real-core regression failed before this metadata existed, then passed: indexed red and identical truecolor red have different bright eligibility, and an OSC 4 update to the bright entry reaches the metadata. Existing style/memory-growth assertions now include the new bold metadata.
- Added renderer policies inherit, bright and explicit RGB. Inherit preserves the existing behavior. Bright changes only eligible bold indexed foregrounds; explicit RGB applies to all bold text. The policy runs before inverse and faint, then selection/cursor and contrast policies apply. Source cells are not mutated. The surface forwards the optional policy, but no durable/public bold setting exists yet.
- Reused the core's existing faint-color function in the renderer so the same dimming weights apply. Real Chromium tests first failed on the absent bold policy, then verified indexed-versus-truecolor behavior, live OSC bright updates, explicit color, reverse/faint ordering and selection precedence with exact pixels.
- Focused checks: 9 core tests passed (`/tmp/ade-bold-metadata-green.log`); 10 actual-rendering tests passed (`/tmp/ade-bold-precedence.log`). Initial failures are `/tmp/ade-bold-metadata-red.log` and `/tmp/ade-bold-renderer-red.log`.
- Ticket remains open. Next: durable/public bold policy and desktop controls, native-query and persistence evidence for that policy, then remaining contrast and importer cases.


Bold-renderer verification:

- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts`: 11 passed (4.8s), `/tmp/ade-bold-renderer-protocol.log`.
- Rebuilt the desktop (`/tmp/ade-bold-renderer-build.log`). The first two-test desktop regression run passed color controls but failed the contrast test while reading a zero-width canvas immediately after returning from Settings. The pixel reader now returns a nonmatching not-ready value until the bitmap has dimensions; both the zero-pixel fidelity assertion and positive corrected-pixel assertion still require their original results.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts --grep 'terminal color controls|terminal contrast controls'`: 2 passed (2.1s), `/tmp/ade-bold-renderer-desktop-final.log`. Earlier failure: `/tmp/ade-bold-renderer-desktop.log`.
- The first full static gate passed 332 renderer tests and 863 Rust tests, with 1 existing skip (`/tmp/ade-bold-renderer-static.log`). The exact-state rerun after the readiness fix is recorded below when complete.

- Final exact-state `pnpm check:static` passed: 332 renderer tests, 863 Rust tests, 1 existing skip. Log: `/tmp/ade-bold-renderer-static-final.log`. `git diff --check` passed. Public bold preferences and controls remain next; no ticket or shared TH row is closed.

2026-09-29 — Durable bold policy and desktop controls.

- Added revision-checked terminal_bold_color profile settings: inherit (default), bright or an explicit RGB value. The shared contract rejects invalid modes, invalid RGB channels and unknown RGB fields. Daemon persistence, reset, runtime projection, ordered attachment frames and recovery snapshots carry the policy, including independently bound terminals.
- CLI parsing, generated SDK contracts and the typed Electron bridge expose the same setting. Stock controls offer Keep source colors, Use bright palette and Custom color. The description documents indexed/truecolor behavior and ordering before reverse video, dimming, selection and contrast correction.
- The real-process protocol test verifies CLI selection, atomic rejection, stale-revision conflict, daemon restart and restoration into two WASM views of a fixed Chalk terminal. Initial expected failure: `/tmp/ade-bold-settings-red.log`; integrated protocol suite: 28 passed (5.9s), `/tmp/ade-bold-protocol-integrated.log`.
- The new built-desktop test uses real OSC palette overrides and identical indexed/truecolor red text. Bright mode produces green indexed text while retaining truecolor red. Custom mode recolors both; returning to source colors restores red. All changes preserve app tokens, complete source appearance apart from the three expected revision increments, runtime identity, shell PID and terminal byte counts.
- The first desktop run passed pixel checks but incorrectly expected an unchanged appearance revision. Corrected that test to require exactly three increments without relaxing source-color equality. Failure log: `/tmp/ade-bold-controls.log`; corrected targeted test: 1 passed (2.5s), `/tmp/ade-bold-controls-final.log`.
- Backend build and initial full static gate passed (`/tmp/ade-bold-settings-backend.log`, `/tmp/ade-bold-settings-static.log`). Desktop build passed (`/tmp/ade-bold-desktop-build.log`). Final integrated desktop and exact-state static runs are pending below.
- Ticket remains in progress. Explicit native-query evidence with bold policies, remaining contrast selection/cursor edge cases, desktop relaunch acceptance, and importer preference-preservation/diagnostic evidence remain outstanding. No shared TH row is closed.

Final durable-bold slice validation:

- `pnpm check:static`: passed, 332 renderer tests and 863 Rust tests, with 1 existing skip. Log: `/tmp/ade-bold-settings-static-final.log`.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts`: 28 passed (5.9s), `/tmp/ade-bold-protocol-integrated.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts`: 26 passed (1.0m), `/tmp/ade-bold-desktop-integrated.log`.
- `git diff --check`: passed. The remaining criteria above are still open; this evidence completes the durable-bold slice, not ticket 06 or the full theming goal.

2026-09-29 — Native queries, desktop relaunch and painted-background contrast.

- Added a real PTY query test with two simultaneous WASM attachments. For bright, explicit RGB and inherit, OSC 4 indexes 1/9 and OSC 10/11/12 retain their source values. Every queried value occurs exactly once in the collected reply, checking that attachments do not add duplicate responses. Both views retain the source foreground. Targeted result: 1 passed (2.4s), `/tmp/ade-bold-query.log`.
- Added built-desktop relaunch acceptance using the actual controls. Custom black bold text with contrast 21 is restored as visible white glyphs over a black source background. Both controls retain their saved values; runtime identity, shell PID and terminal bytes remain unchanged across desktop quit/relaunch. Targeted result: 1 passed (4.5s), `/tmp/ade-readability-relaunch.log`.
- Added actual Ghostty/Chromium selection and cursor contrast tests. A 50%-white selection on black uses its composited 128-gray fill and reaches 23-gray glyphs at 4.5:1. White block-cursor text on a white cursor becomes black at 21:1. Both cases require unchanged source cells and byte-for-byte identical canvas output after restoring fidelity. Renderer run passed all 334 tests (`/tmp/ade-contrast-overlays.log`); the command's extra separator selected the full suite, not only the requested file.
- Import preference preservation and unsupported-policy diagnostics still require the production importer in tickets 09–11. Those tickets remain in scope. Ticket 06 stays in progress until that integration evidence exists; its dependency on ticket 05 is unchanged, and other eligible work may proceed.

Integrated acceptance for the query/relaunch/contrast cases:

- `pnpm check:static`: passed, including 334 renderer tests and 863 Rust tests, with 1 existing skip. Log: `/tmp/ade-readability-static.log`.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts`: 29 passed (11.4s), `/tmp/ade-readability-protocol.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts`: 27 passed (1.3m), `/tmp/ade-readability-desktop.log`.
- `git diff --check`: passed. Accepted the first four criteria based on the combined source, protocol, rendering and desktop evidence. Import-specific acceptance remains open, and ticket 06 remains in progress. Shared TH rows remain unverified pending contributor reconciliation.


### 2026-09-30 — Accept importer isolation and optional readability proposals

The remaining importer criterion now passes. The common ADE library installation path preserves profile preferences; Ghostty validation separately returns inert minimum-contrast and bold-color proposals, and installing its canonical color definition leaves the complete profile settings unchanged. Unsupported settings and values receive source-located warnings. Current Ghostty config discovery remains ticket 11's work; that importer must reuse the same color/settings separation rather than implicitly applying settings.

Users can review current profile settings, explicitly select either proposal, inspect the imported colors and current light/dark terminal samples, then apply only the selected preferences. The operation uses the ordinary settings mutation with captured appearance and displayed-definition revisions. Cancel leaves preferences unchanged. A conflict clears acceptance and requires fresh review. Supported setting proposals remain available when the file has invalid colors, while color acceptance/installation stays disabled. Applying preferences does not install or select the color definition.

This completes ticket 06's own criteria together with its earlier durable-state, native-query, renderer precedence, pixel, shared-view and desktop-relaunch evidence. Its approved prerequisite 05 is done. TH17 evidence is ready for final matrix reconciliation; shared TH26 still requires 16 and 17. The complete theming goal remains open.

Final evidence:

- `pnpm build:backend`: passed (`/tmp/ade-ghostty-policies-backend-final.log`). Native/WASM pins remain `9c96f7ddb3be2cc575a159d4d1f1d49fb10d7006`; the native archive is present.
- `pnpm check:static`: passed, including 313 API operations, 253 JavaScript tests, 341 renderer tests, Clippy and 871 Rust tests with one existing skip (`/tmp/ade-ghostty-policies-static-final.log`). An earlier complete gate also passed before the independent invalid-color UI slice (`/tmp/ade-ghostty-policies-static.log`).
- `pnpm test:e2e:protocol:only e2e/protocol/profiles/ghostty-theme.spec.ts e2e/protocol/profiles/ghostty-export.spec.ts e2e/protocol/terminals2/ghostty-theme.spec.ts e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/profiles/theme-library.spec.ts`: **30 passed** (`/tmp/ade-ghostty-policies-protocol-final.log`). The public settings action persists independently; stale revisions are refused. Cases cover color-install preference isolation, CLI/SDK proposal parity, defaults/resets, clamping, duplicate/invalid values, inert unsupported options, native query/source-color preservation with two attached views, imported extended colors and recovery.
- `pnpm test:e2e:desktop:only e2e/desktop/ghostty-theme.spec.ts e2e/desktop/appearance-preview.spec.ts e2e/desktop/ghostty-export.spec.ts e2e/desktop/appearance.spec.ts`: **39 passed** (`/tmp/ade-ghostty-policies-desktop-final.log`). Cases cover explicit subset acceptance, corrected glyph pixels in a local sample, both-mode profile samples, retained data after source deletion, cancellation, conflicts/fresh acceptance, independent settings from invalid colors, installed-theme isolation and existing live readability/startup/relaunch/preview recovery.
- Inspected `test-results/desktop/ghostty-theme-desktop-impo-12287-rate-preview-and-acceptance/ghostty-optional-settings.png`; all three samples, the separate Apply action and its result are visible and clear of the scrollbar.
- Direct standards/spec review checked bounded inert parsing, current pin semantics, query-only preview resolution, revision fences, stock UI composition and selected-field-only settings publication. `git diff --check` passed. No delegated agent, commit or push.
