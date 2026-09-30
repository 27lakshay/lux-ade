# 10 — Import and export Ghostty theme files

Status: in-progress
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Use a Ghostty theme file in ADE and export compatible terminal colors back to Ghostty without silently changing their meaning.

**Blocked by:** [09 — Manage custom themes and ADE import/export](09-ade-theme-library.md)

**Spec coverage:** TH10, TH11, TH18. User stories 27, 30, 33, 45–46, 49–50. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Parse actual Ghostty key/value grammar, full-line comments, hashes in color values, duplicate assignments, permitted empty resets and X11 names with source-located diagnostics.
- [x] Import foreground/background, all palette indexes 0–255, cursor color/text and selection foreground/background, including supported cell-relative meanings.
- [x] Theme-file import reads selected color data only. Commands, unrelated configuration and executable behavior never run.
- [x] Preview and install use the common library and preserve source attribution. Appearance policies are separate opt-in results when supported and otherwise listed as unsupported.
- [x] Deterministic export/reimport preserves every supported terminal value and lists unrepresentable data or renderer-only policies as omissions. Export does not modify installed Ghostty configuration.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Run parser fixtures and public round trips, then import a file through the desktop and compare native color queries, cursor/selection samples and all indexed colors.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.


## Comments

### 2026-09-30 — Verify Ghostty preview layout and final regression gates

Screenshot inspection found two layout problems in the new preview flow. The long native source path caused 53 pixels of horizontal overflow. Wrapping long text removed that overflow, but the overlaid vertical scrollbar still covered the last 10 pixels of the ID/name inputs and Review button. A second desktop assertion reproduced that obstruction by comparing visible control bounds with the scrollbar's left edge. The first version of the bounds check also included a hidden checkbox input; the final assertion excludes inputs with no visible width.

The dialog now wraps long text and reserves scrollbar space in a plain wrapper around the stock FieldGroup. An intermediate static run rejected padding on FieldGroup through the existing shadcn no-restyle lint rule; moving that spacing to the wrapper preserves the stock kit. No lint suppression or kit component change was added. The desktop regression checks zero horizontal overflow before installation and unobstructed visible controls after installation.

Final evidence on the corrected build:

- `pnpm check:static`: **passed**, including 313 API operations, 253 JavaScript tests, 341 renderer tests, Clippy and 871 Rust tests with one existing skip (`/tmp/ade-ghostty-preview-static-complete.log`). The earlier lint rejection remains recorded in `/tmp/ade-ghostty-preview-static-scrollbar.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/ghostty-theme.spec.ts e2e/desktop/appearance-preview.spec.ts e2e/desktop/ghostty-export.spec.ts`: **7 passed** (`/tmp/ade-ghostty-preview-desktop-complete.log`). Candidate background pixels, unchanged committed appearance, retained-source installation, conflicts, existing preview isolation/recovery and native export remain covered. The scrollbar regression first failed in `/tmp/ade-ghostty-preview-scrollbar-red.log`, then passed with the wrapper fix.
- `pnpm test:e2e:protocol:only e2e/protocol/profiles/ghostty-theme.spec.ts e2e/protocol/profiles/ghostty-export.spec.ts e2e/protocol/terminals2/ghostty-theme.spec.ts`: **8 passed** (`/tmp/ade-ghostty-preview-protocol-complete.log`).
- Inspected the newly captured `test-results/desktop/ghostty-theme-desktop-revi-8df55-d-data-without-selecting-it/ghostty-theme-import-wrapped.png`. It shows complete input/button edges, wrapped diagnostics and the temporary terminal sample clear of the scrollbar.
- Direct standards/spec review checked the query-only candidate resolver, isolated asynchronous sample disposal, shared preview use and stock dialog composition. `git diff --check` passed. No commit, push or delegation.

The uninstalled visual preview is verified. Ticket 10 still awaits cell-relative cursor fill support, independently accepted import policy proposals, complete pixel evidence and its approved prerequisite chain. Shared TH rows remain unverified as aggregates.

### 2026-09-30 — Color-only import through the public API and built desktop

This is independent preparation on ticket 09's accepted library behavior. The approved dependency on 09 remains open through 08 and 07's missing production code/file/diff consumers. No parent scope or dependency edge changed. TH10/TH11/TH18 remain unverified as aggregate rows.

Users can choose one Ghostty theme file in Settings, provide its stable ID/name/light-or-dark mode, review source-located diagnostics, explicitly accept its colors and install it through the common revision-checked library. Installation retains the original text, source name, SHA-256 digest and pinned parser commit. It does not select the theme. The source file can disappear after review without invalidating accepted data. A concurrent definition change clears acceptance; reviewing the retained source captures the current revision before retry.

The query `themes.ghostty.validate` returns canonical ADE source and the common validation/target revision report. The SDK exposes its generated types. `ade themes ghostty-validate FILE ID NAME MODE` returns the same report; invalid color data exits with status 2. Desktop failures retain structured errors through the existing registered-window IPC guard.

The importer follows the pinned `cli/args.zig` line grammar: full-line comments, first `=`, whitespace/CR trimming, paired outer double quotes without unescaping, hashes retained in values, no inline-comment stripping, last valid assignments, and empty resets. It calls the pinned native `ghostty_color_parse`, `ghostty_color_parse_palette_entry` and `ghostty_color_palette_default` ABI rather than copying an X11 table or approximating colors. Named colors are ASCII case-insensitive: the map uses `std.static_string_map.eqlAsciiIgnoreCase`. An early test incorrectly expected lowercase `forestgreen` to fail; direct inspection of that custom matcher and the real native result corrected the test.

Defaults come from the pinned Ghostty implementation: foreground `#ffffff`, background `#282c34`, all 256 native palette defaults, omitted cursor fill/text from window foreground/background, and omitted selection colors from inverted window background/foreground. They do not inherit ADE Graphite or the currently selected profile. Explicit cell-relative cursor text and selection colors retain their symbolic meanings. The supplied source and the materialized retained definition each stay within 256 KiB; lines stay within the pinned 4094-byte data buffer; diagnostics stay bounded to 128. SDK/daemon request admission grants this operation the existing bounded theme allowance without widening ordinary operations.

Only supported color assignments are applied. Unknown configuration, commands, includes, fonts and appearance policies remain inert source data with warnings. Includes are not resolved, source names are attribution only, and the parser launches no command. Generated/harmonious palettes produce explicit errors when requested. Cell-relative cursor fill currently produces `unsupported_cell_cursor`; no fallback silently turns it into fixed RGB.

The native parser is also linked into the daemon through the existing runtime library without changing terminal process ownership or the sole native query responder. A normal `static=ghostty-vt` link allowed the macOS runtime test binary to pick the adjacent dylib. The build now copies the pinned archive under a private static archive name; the full Rust gate passes and `otool -L` confirms the runtime test binary no longer depends on Ghostty's dylib. The pin and WASM were not changed. No new package, copied reference source or compatibility migration was added.

Evidence:

- Red protocol test: `pnpm test:e2e:protocol:only e2e/protocol/profiles/ghostty-theme.spec.ts` failed against the missing operation (`/tmp/ade-ghostty-import-red.log`).
- Red desktop test: `pnpm test:e2e:desktop:only e2e/desktop/ghostty-theme.spec.ts` failed at the missing Import Ghostty theme button (`/tmp/ade-ghostty-desktop-red.log`).
- Final public-process checks: `pnpm test:e2e:protocol:only e2e/protocol/profiles/ghostty-theme.spec.ts e2e/protocol/terminals2/ghostty-theme.spec.ts e2e/protocol/profiles/theme-validation.spec.ts e2e/protocol/profiles/theme-library.spec.ts`: **13 passed** (`/tmp/ade-ghostty-protocol-accepted.log`). Native OSC foreground/background/cursor/indexed replies agree with imported colors; the WASM view resolves custom indexes 16/255 to the same cell RGB values. Killing/restarting the daemon preserves those colors, the run ID and shell PID. Other cases cover parser errors, quoted values, X11 names, empty resets, duplicate indexes, ignored configuration, UTF-8 source locations, unsupported generation/cell cursor, limits, retained provenance and CLI/SDK parity.
- Final built desktop: `pnpm test:e2e:desktop:only e2e/desktop/ghostty-theme.spec.ts e2e/desktop/theme-errors.spec.ts`: **6 passed** (`/tmp/ade-ghostty-desktop-accepted.log`). Invalid imports cannot be accepted; an installed revision conflict requires review; retry succeeds from retained data after file deletion. Appearance remains unchanged throughout import. The screenshot `test-results/desktop/ghostty-theme-desktop-revi-8df55-d-data-without-selecting-it/ghostty-theme-import.png` was inspected; it shows the stock dialog, source attribution, mode, diagnostics, explicit acceptance and installation result.
- `pnpm check:static`: **passed**, including 312 API operations, 253 JavaScript tests, 341 renderer tests in 47 files, Clippy and 871 Rust tests with one existing skip (`/tmp/ade-ghostty-import-static-complete.log`). Earlier runs caught stock-kit sizing/height rule violations and the macOS dynamic link problem; both were fixed, then the complete gate passed. Added E2E assertions were corrected to use the actual CLI snapshot surface and stock dialog Escape behavior; acceptance assertions were preserved.
- `git diff --check`: passed. No commit or push.

Remaining work before this ticket can close:

- Add cell-relative cursor fill to the complete effective appearance, native/WASM adapter and actual cursor rendering, preserving OSC overrides and reset behavior.
- Add deterministic Ghostty export/reimport and native file publication with explicit omissions for alpha, app/syntax data and renderer-only policies.
- Add visual preview of an uninstalled Ghostty candidate through the common temporary preview path.
- Reconcile supported optional policy proposals and their independent acceptance; imported policies currently appear only as not-applied warnings.
- Finish all-index/cursor/selection pixel acceptance and the approved prerequisite chain before closing shared TH rows.


### 2026-09-30 — Deterministic Ghostty export and atomic files

The query `themes.ghostty.export` now exports an inspected definition at a required revision. It reuses the library export revision check, validates retained definition data before accessing required roles, and emits foreground/background, cursor fill/text, selection foreground/background and all 256 numeric palette assignments in deterministic order. It explicitly disables generated/harmonious palettes. Literal RGB and supported cell-relative cursor-text/selection values round trip through the same pinned importer. Fully opaque ADE selection alpha exports as equivalent RGB; translucent alpha is an explicit color omission.

The response lists omissions for app/syntax colors, pack identity, ADE provenance, retained extensions, unsupported terminal tokens and profile/runtime appearance preferences. Original command/include data is never emitted as executable Ghostty configuration. The report retains the theme summary and source attribution. This exports definition colors; it does not serialize live OSC overrides or silently change profile preferences.

The CLI command `ade themes ghostty-export ID REVISION [--output PATH] [--overwrite]` and SDK query expose the same report. `writeGhosttyThemeExport` publishes the exact daemon bytes through the existing atomic host writer and returns byte count/hash, definition revision and omissions. Existing targets require explicit replacement. A stale definition is refused before any file publication, including when overwrite was requested.

The desktop library offers Export Ghostty colors, shows its text and omissions, then enables Export Ghostty colors to file. The native picker selects the destination; the renderer cannot supply a path. Native cancellation preserves existing content, while explicit replacement atomically publishes the reviewed revision. The existing ADE definition and pack file flows use the same destination helper with their original titles/extensions.

Evidence:

- The first export protocol test failed at the missing operation (`/tmp/ade-ghostty-export-red.log`). The first desktop test failed at the missing file-export control (`/tmp/ade-ghostty-export-desktop-red.log`).
- A later test showed that opaque `#112233ff` was unnecessarily omitted. The exporter now emits equivalent `#112233`; translucent `#11223380` remains listed as an omission. CLI assertions were corrected against the existing documented exit codes: local file conflicts use 8 and daemon theme conflicts use 7. No CLI exit behavior changed.
- Final backend rebuild: `pnpm build:backend` passed (`/tmp/ade-ghostty-export-final-build.log`).
- `pnpm test:e2e:protocol:only e2e/protocol/profiles/ghostty-export.spec.ts e2e/protocol/profiles/ghostty-theme.spec.ts e2e/protocol/terminals2/ghostty-theme.spec.ts e2e/protocol/profiles/theme-export-file.spec.ts`: **12 passed** (`/tmp/ade-ghostty-export-protocol-accepted.log`). Cases cover deterministic output, supported-color round trips, omission reports, opaque alpha, CLI/SDK parity, exclusive file publication, stale revisions, imported native/WASM colors and existing ADE export recovery.
- `pnpm test:e2e:desktop:only e2e/desktop/ghostty-export.spec.ts e2e/desktop/ghostty-theme.spec.ts e2e/desktop/theme-export-file.spec.ts e2e/desktop/theme-pack.spec.ts`: **9 passed** (`/tmp/ade-ghostty-export-desktop-accepted.log`). The Ghostty flow compares the entire reimported terminal-token map with Graphite, verifies cancellation and explicit overwrite, and proves that a seeded installed Ghostty configuration remains byte-for-byte unchanged. Profile appearance also remains unchanged. A final visible-status screenshot check passed separately (`/tmp/ade-ghostty-export-desktop-visible.log`). The rendered screenshot `test-results/desktop/ghostty-export-desktop-dis-ec094-ing-a-compatible-color-file/ghostty-theme-export.png` was inspected.
- `pnpm check:static`: **passed**, including 313 API operations, 253 JavaScript tests, 341 renderer tests in 47 files, Clippy and 871 Rust tests with one existing skip (`/tmp/ade-ghostty-export-static-accepted.log`).
- Direct standards/spec review checked the new serializer, common atomic writer, revision admission, IPC guard, omission display and stock UI composition. The serializer now revalidates stored data so missing required roles produce an error rather than an indexing panic. No delegated agent, commit or push was used. `git diff --check` passed.

The export criterion now passes for the supported definition model. This ticket remains in progress: cell-relative cursor fill import/rendering, uninstalled visual previews, optional policy proposals and complete cursor/selection/all-index pixel evidence remain open. The approved 09 → 08 → 07 prerequisite chain and aggregate TH10/TH11/TH18 status are unchanged.


### 2026-09-30 — Preview an uninstalled Ghostty candidate

A valid `themes.ghostty.validate` response now includes an optional resolved `TerminalAppearance` preview. The daemon uses the same `TerminalAppearance::for_palette` resolver as installed definitions; the candidate's complete validated terminal tokens supply its colors. Invalid sources return no preview. The response remains a query and does not install, select or publish appearance changes. Source previews use minimum contrast 1 and inherited bold color; imported policies remain not-applied warnings pending their independent proposals.

The import dialog draws these colors before acceptance or installation. `TerminalAppearancePreview` now owns the existing isolated `createTerminalPreview` mount/update/dispose path and is shared with the complete appearance preview. It has no terminal attachment, input bridge, live output state or durable cache. It disposes a late-created sample after unmount and updates the current theme before mounting an asynchronously loaded core. The code/diff/app sample behavior remains in `AppearancePreviewSample`.

Evidence:

- The public protocol test failed before the new preview field existed (`/tmp/ade-ghostty-preview-red.log`).
- `pnpm check:static`: **passed**, including 313 API operations, 253 JavaScript tests, 341 renderer tests in 47 files, Clippy and 871 Rust tests with one existing skip (`/tmp/ade-ghostty-preview-static.log`). The backend was rebuilt afterward (`/tmp/ade-ghostty-preview-backend.log`).
- `pnpm test:e2e:protocol:only e2e/protocol/profiles/ghostty-theme.spec.ts e2e/protocol/profiles/ghostty-export.spec.ts e2e/protocol/terminals2/ghostty-theme.spec.ts`: **8 passed** (`/tmp/ade-ghostty-preview-protocol.log`). A valid source returns exact candidate RGB and default readability; invalid data returns a null preview. CLI/SDK reports still agree, saved appearance remains unchanged, and Ghostty export/native/WASM recovery checks pass.
- `pnpm test:e2e:desktop:only e2e/desktop/ghostty-theme.spec.ts e2e/desktop/appearance-preview.spec.ts e2e/desktop/ghostty-export.spec.ts`: **7 passed** (`/tmp/ade-ghostty-preview-desktop.log`). Before installation, the Ghostty dialog displays the actual canvas and its background pixel is exactly `[40, 44, 52, 255]`, the pinned imported default rather than the selected ADE palette. File deletion after review and revision-conflict recovery still work. Existing both-mode local preview, native query/cache isolation, Escape focus restoration, explicit rebase, persistence-failure retry and independent terminal/syntax drafts remain accepted.
- The Ghostty import screenshot was inspected. Direct review checked the shared mount/update/dispose path, validation guard and absence of live terminal/cache bridges. `git diff --check` passed. No commit, push or delegated agent.

Uninstalled visual preview is now implemented. This does not close the combined preview/policy criterion: independent imported policy proposals remain open. Cell-relative cursor fills and complete all-index/cursor/selection pixel acceptance also remain open, alongside the approved prerequisite chain and aggregate TH rows.


### 2026-09-30 — Independently preview and accept Ghostty settings

`themes.ghostty.validate` now returns typed nullable `policies.minimum_contrast` and `policies.bold_color` proposals alongside its color validation and fidelity preview. These values never enter installed terminal tokens or change profile settings through color installation. The original text and attribution remain retained data. Existing CLI validation and SDK calls return the same proposal report; no separate implicit import command or new durable setting was added.

Pinned `src/config/Config.zig` and `src/cli/args.zig` were inspected. Supported finite decimal/exponent contrast values clamp to 1–21 with a diagnostic when clamped; an empty reset proposes 1. Bold values support `bright`, pinned native color parsing (including X11 names), and an empty reset to inherited source colors. Last supported assignments/resets win with located duplicate diagnostics. Invalid values remain unsupported warnings and do not invalidate otherwise usable colors. Non-finite or unrecognized numeric forms are not proposed. Cursor opacity/style, typography, background opacity and the deprecated bold-is-bright setting remain explicit unsupported warnings. Commands/includes remain inert. The public Ghostty web reference could not be fetched and llms.txt returned 404; the matching local pin supplied the authoritative semantics. No dependency or reference source was copied.

The desktop has a separate Review optional settings action. Each available setting starts unchecked. Temporary samples show the proposal on imported colors when valid, plus the current profile terminal colors in both app modes through the existing pure preview query. That query captures definition revisions; review also checks that its appearance revision matches the settings snapshot. Apply changes only selected preference fields through the common settings operation and both revision fences. A conflict clears acceptance; explicit review and selection are required before retry. Cancel is read-only. Supported proposals remain independently usable when color data is invalid, using only the current profile samples. Color acceptance and installation remain disabled in that case.

Evidence:

- The initial public test failed on the missing policies field (`/tmp/ade-ghostty-policies-red.log`); it passed after the typed proposal implementation (`/tmp/ade-ghostty-policies-protocol-green.log`).
- The initial desktop test failed on the missing Review optional settings action (`/tmp/ade-ghostty-policies-desktop-red.log`). The both-mode profile sample test then failed with one image instead of three (`/tmp/ade-ghostty-policies-profile-preview-red.log`), and passed after using the common preview resolver. The independent invalid-color test failed on the unavailable setting-review action (`/tmp/ade-ghostty-policies-independent-red.log`), and passes with independent settings admission.
- Final backend build and full static gate passed (`/tmp/ade-ghostty-policies-backend-final.log`, `/tmp/ade-ghostty-policies-static-final.log`): 313 operations, 253 JavaScript tests, 341 renderer tests, Clippy, 871 Rust tests, one existing skip.
- Final integrated public-process run: **30 passed** (`/tmp/ade-ghostty-policies-protocol-final.log`), using ghostty-theme, ghostty-export, terminals2/ghostty-theme, terminals2/appearance and theme-library specs. Final integrated desktop run: **39 passed** (`/tmp/ade-ghostty-policies-desktop-final.log`), using ghostty-theme, appearance-preview, ghostty-export and appearance specs. Exact commands and coverage are recorded in ticket 06's acceptance comment.
- Inspected the new optional-settings screenshot and reviewed the parser, contract, isolated samples, conflict handling and stock controls directly. `git diff --check` passed. No commit, push or delegation.

The preview/common-library/optional-policy criterion now passes. Ticket 10 remains in progress for cell-relative cursor fills, complete all-index/cursor/selection pixel evidence and the approved 09 → 08 → 07 prerequisite chain. Aggregate TH10/TH11/TH18 remain open. Ticket 06's import criterion is now accepted; later config import must preserve this separation.
### 2026-09-30 — Render symbolic cursor fills and all indexed colors

The effective terminal appearance now carries symbolic cursor-fill policies through the generated contract, native adapter and Ghostty renderer. The live renderer resolves cell-relative fill after reverse-video processing and keeps explicit OSC 12 overrides ahead of the theme value; OSC 112 reset restores the symbolic theme policy. Both the mounted terminal surface and the shared preview pass that cursor policy to rendering.

The desktop test `mounted desktop paints all 256 indexed palette colors to Canvas` sends 256 background-indexed swatches through a real PTY and observes all 256 distinct expected RGB values in the built Canvas. The cursor test verifies both `cell-foreground` and `cell-background` against truecolor content. Existing terminal-color controls cover visible cursor text and selection pixels.

Evidence:

- `pnpm test:e2e:protocol:only e2e/protocol/profiles/ghostty-theme.spec.ts e2e/protocol/profiles/ghostty-export.spec.ts e2e/protocol/terminals2/ghostty-theme.spec.ts e2e/protocol/terminals2/appearance.spec.ts`: **24 passed** (`test-results/runs/protocol-5d91673c-25bb-4d1a-82db-ed709f50d3aa`). This includes imported native color queries and Ghostty WASM indexed-color resolution.
- `pnpm test:e2e:desktop:only e2e/desktop/ghostty-theme.spec.ts e2e/desktop/appearance.spec.ts`: **36 passed** (`test-results/runs/desktop-93de073f-6f92-42f1-a6eb-6474a558a719`). Both new pixel assertions and existing literal cursor-text/selection checks passed in the built Electron app.

The cell-relative import/render and visual color criteria now have exercised evidence. The approved 09 → 08 → 07 production-consumer chain remains open, so ticket 10 and aggregate TH10/TH11/TH18 remain in progress. The final `pnpm check:static` result is still pending.
### 2026-09-30 — Final static and discovery checks

The earlier note marked static verification as pending. The final gate has now passed:

- pnpm check:static passed. It ran rustfmt, oxfmt, contract/theme-default/architecture checks, typecheck, lint/dead-code checks and CLI/desktop builds; 876 legacy Rust tests passed with one skip, and Rust doctests passed (test-results/runs/static-0246d625-09a1-41f9-9f54-de9c4ee246dc).
- pnpm test:discovery passed: 48 Node files, 47 browser files, 222 protocol files, 16 desktop files, and 877 Rust tests discovered with 18 historical exclusions.
- The static run reported one retained temporary runtime directory during cleanup; the gate completed successfully.

Ticket 10's cell-relative color import/render and pixel-evidence work is complete. Ticket 10 itself remains in progress because the approved 09 → 08 → 07 production-consumer chain remains open; TH10/TH11/TH18 remain open. The full ordinary pnpm test:acceptance suite was not run.
