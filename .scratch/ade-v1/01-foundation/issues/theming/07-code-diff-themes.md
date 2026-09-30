# 07 — Theme code blocks, previews and diffs independently

Status: in-progress
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Choose syntax colors separately from the shell and see consistent code and diff states without losing reading or editing state.

**Blocked by:** [03 — Ship all 12 palettes with system switching and correct startup colors](03-palettes-system-startup.md)

**Spec coverage:** TH02, TH25. User stories 8, 65–67, 77. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Syntax binding supports follow-app, independent light/dark variants and fixed variants through desktop and public operations.
- [ ] Shiki and Pierre consumers map the shared syntax and surface roles, including selections, gutters, search, diagnostics, changed words and conflicts where supported.
- [ ] Palette-only changes use supported CSS-variable adapters where possible and preserve documents, history, caret and scroll rather than rebuilding surfaces.
- [x] TextMate-to-semantic and CodeMirror-tag mapping limits are documented. A CodeMirror adapter is defined and exercised against existing consumers when present; this ticket does not implement the excluded editor.
- [ ] Existing production code blocks, previews and diffs provide acceptance evidence. A missing required surface is recorded as a dependency and cannot be replaced by a showcase to claim completion.
- [ ] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Exercise selection through public operations and built-desktop code/diff surfaces; use renderer tests for mapping and state preservation. General F073/F074 evidence does not establish TH25.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Comments

2026-09-29 — Prerequisite inspection while finishing ticket 06 acceptance.

- The current production tab renderer (`apps/desktop/src/renderer/src/features/workspace/content/tab-content.tsx`) renders TerminalContent only and returns null for other target kinds. Searches of renderer source found no production Shiki, Pierre or CodeMirror consumers.
- The desktop manifest already pins Shiki 4.4.3, @pierre/diffs 1.5.1 and CodeMirror packages. Installed dependencies do not prove a production code/diff surface exists.
- Syntax settings, shared resolution and adapter work can proceed. The existing-production-surface acceptance criterion remains dependent on the owning conversation/file/diff surfaces. Do not substitute a synthetic showcase or claim TH25 from adapter tests alone. This finding does not remove ticket 07 or later dependent features from the approved scope.

2026-09-29 — Independent syntax binding through public settings and desktop controls.

- Added syntax_binding using the shared follow_app, paired and fixed ThemeBinding contract. The daemon validates IDs and mode slots before mutation, persists the choice, checks expected appearance revisions and restores follow_app through the core reset operation.
- Generalized the existing terminal binding validator/resolver to shared theme binding functions. Resolution retains selected identity and same-mode fallback diagnostics. settings.appearance now includes a separate syntax result with its binding, selected identity, resolved palette and diagnostics. App tokens and terminal colors remain separate.
- Added named CLI JSON parsing, regenerated contracts, typed Electron forwarding and stock provisional controls. Users can choose fixed or paired syntax themes and see the resolved name and mode. Controls use the existing revision-checked mutation and failure display.
- The protocol test failed before implementation (`/tmp/ade-syntax-binding-red.log`). The new test plus settings regressions passed: 9 tests (17.9s), `/tmp/ade-syntax-protocol.log`. Coverage includes fixed dark syntax in a light app, independent light/dark slots, invalid/missing selections, atomic rejection, stale revision conflicts, daemon restart and reset.
- The built-desktop control test passed (17.3s), `/tmp/ade-syntax-desktop.log`: fixed and paired selection, unchanged app/terminal source colors, app-mode switching, desktop relaunch and return to follow-app.
- Adapter work and production code/diff acceptance remain open. No code recoloring, state-preservation or TH25 completion is claimed by these settings tests. Official API research started with https://shiki.style/guide/theme-colors and https://codemirror.net/examples/styling/; pinned adapter APIs and agent resources still need inspection before adapter integration.

Adapter research for the next slice:

- Pierre publishes an agent index at https://diffs.com/llms.txt, linking its agent skill and full documentation. Shiki/CodeMirror llms.txt probes were inaccessible through the browser tool; do not treat that as proof that no agent guidance exists.
- The installed @pierre/diffs 1.5.1 package exposes registerCustomCSSVariableTheme(name, variableDefaults, fontStyle). Its implementation wraps Shiki createCssVariablesTheme using Pierre's global variable prefix and registers it through registerCustomTheme. Inspect the generated variable roles and surface styles before choosing whether the convenience mapping covers ADE's required semantics.
- Shiki's official theme-colors guide supports arbitrary CSS-variable colors and recommends explicit theme construction for finer mapping than its convenience theme. CodeMirror's styling guide separates editor themes from HighlightStyle tags. These are integration directions, not completed adapters or acceptance evidence.

Integrated validation exposed three desktop regressions (25 passed, 3 failed; `/tmp/ade-syntax-desktop-integrated.log`):

- Follow-app syntax reused the app fallback diagnostic verbatim, making the same warning appear twice without identifying its scope. The syntax section now prefixes its diagnostic with “Syntax:”.
- Generalizing the resolver changed “Selected terminal theme” to “Selected theme”; the terminal fallback acceptance now expects the shared wording while retaining the same identity, fallback and reset checks.
- Settings editors were keyed by the global appearance revision, so saving one setting could remount another editor and discard its draft. They now key by their own saved value. The relaunch regression now deliberately drafts contrast 21 before saving a bold color and requires that draft to survive before applying it. This strengthens the behavior check instead of adding a timing delay.

The initial static gate passed (334 renderer tests, 863 Rust tests, 1 existing skip), and all 30 integrated protocol tests passed (20.1s, `/tmp/ade-syntax-protocol-integrated.log`). A fresh full static gate and rebuilt desktop suite are required after these fixes.

Final verification for the syntax-selection slice:

- `pnpm check:static`: passed after the draft/diagnostic fixes, including 334 renderer tests and 863 Rust tests (1 existing skip). Log: `/tmp/ade-syntax-static-final.log`.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts e2e/protocol/profiles/syntax-appearance.spec.ts`: 30 passed (20.1s), `/tmp/ade-syntax-protocol-integrated.log`. Subsequent fixes affected renderer controls and desktop assertions only.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts`: 28 passed (54.4s), `/tmp/ade-syntax-desktop-final.log`, including all three previously failing scenarios and the stronger cross-setting draft assertion.
- Contract generation and backend build passed (`/tmp/ade-syntax-contract.log`, `/tmp/ade-syntax-backend.log`). Static builds rebuilt SDK, CLI and desktop before final desktop acceptance. `git diff --check` passed.
- Accepted only the syntax-binding criterion. Ticket 07 remains in progress for adapters, mapping limits, state preservation and production code/diff acceptance. Shared TH rows remain unverified.

2026-09-29 — Shiki semantic adapter and live code variables.

- Read Shiki's official theme-colors guidance (https://shiki.style/guide/theme-colors) and Pierre's agent-oriented reference (https://diffs.com/llms-full.txt). Pierre's HTML docs exceeded the browser tool's page-size limit; the plain-text reference was accessible and identifies its published diffs skill. No package installation or extension execution was needed.
- Added an explicit Shiki theme using stable --ade-code-* variables. TextMate keyword/storage, string, numeric constant and comment scopes map to ADE's corresponding roles; other scopes inherit syntax-default. Markup additions/deletions use the handed-off diff roles. No font styles are imposed by a color palette.
- Code surface variables remain separate from app and terminal variables. The selected syntax palette supplies base, selection, gutter, active line, search, diagnostic and diff values through existing handoff roles. Live resolved appearance updates these variables without modifying app palette roles. This establishes the mapping boundary; it does not claim each library paints every declared surface role.
- Added a real Shiki/Chromium test using JavaScript grammar output. It verifies literal Graphite/Chalk colors for all five syntax roles and the code background, preserves exact generated HTML and node identity, and retains DOM selection and scroll position while changing only CSS variables.
- Initial expected failure was the missing adapter (`/tmp/ade-code-theme-red.log`). The first implementation run found a test assumption: Shiki groups a leading space into the string span. Token selection now trims that whitespace while retaining exact color assertions. Shiki also triggered Vite's late dependency optimization; the browser-test config now pre-bundles it to avoid mid-test reloads. The corrected focused run passed (`/tmp/ade-code-theme-green-final.log`); the final gate includes the expanded five-role assertions.
- Removed the unused-dependency exemption for Shiki now that the adapter/tests use it. Fallow validates the configuration. The built-desktop syntax settings test now also checks that fixed Carbon syntax publishes its keyword color while the app remains light.
- Pierre and CodeMirror adapters, mapping limitations beyond these initial scopes, and production code/diff acceptance remain outstanding. Ticket 07 remains in progress.

Additional adapter verification findings:

- Expanded assertions initially selected the outer line span for a comment because its text equals the token's text. The test now selects styled token spans, preserving all exact role/color assertions.
- Applying resolved syntax variables exposed an old partial profile-settings test fixture without the required syntax field. Updated that fixture rather than accepting malformed production contracts. Extended the existing stale-reply/daemon-identity/disposal tests to assert code keyword variables also retain the latest accepted value.
- Focused command `pnpm --filter @ade/desktop test src/renderer/src/features/code/code-theme.test.ts src/renderer/src/app/profile-settings.test.ts` passed 4 tests in 2 files (`/tmp/ade-code-theme-focused.log`). Earlier full-gate failures remain recorded in `/tmp/ade-code-theme-static.log` and `/tmp/ade-code-theme-static-final.log`; they are not counted as passing gates.

Final Shiki adapter slice validation:

- `pnpm check:static`: passed, including 335 renderer tests and 863 Rust tests, with 1 existing skip. Log: `/tmp/ade-code-theme-static-verified.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts --grep 'syntax settings|two windows|managed profile'`: 3 passed (11.2s), `/tmp/ade-code-theme-desktop.log`. Static rebuilt the app first. These verify committed variable delivery, profile switching, window synchronization and syntax controls; they do not substitute for absent production code/diff views.
- `git diff --check`: passed. No backend or contract changes in this slice, so the previous 30-test protocol acceptance remains applicable.
- Next: Pierre and CodeMirror integration, detailed mapping limits and production-surface prerequisites. Before accepting first-paint code behavior, extend/verify startup handling for independent syntax variables; the current new adapter applies from live resolved appearance. No additional ticket criterion or shared TH row is marked complete.

2026-09-29 — Pierre theme adapter and real diff rendering.

- Checked the official plain-text reference at https://diffs.com/llms-full.txt and the installed @pierre/diffs 1.5.1 implementation/declarations. Custom theme registration accepts the shared Shiki theme. A lazy registration promise loads Pierre only when a consumer requests its theme and permits retry after a failed load.
- Added scoped mappings for addition/deletion fills and emphasis, gutter colors, selection, hover, buffers, separators and conflict-marker text. They reference the same --ade-code-* variables as Shiki; palette changes require no diff rerender or new tokenization.
- The first real FileDiff test found that Pierre's public background override is a tint target, not a final literal fill. Its row rules blended the supplied ADE muted fill again with the base. Added a small fixed adapter CSS rule setting the pinned row tint weights to zero for addition/deletion rows, preserving ADE's exact muted fills while keeping subsequent hover, selection and decoration layers. Imported themes still supply data only; they cannot supply CSS. Recheck this pinned-library rule on a Pierre upgrade.
- Changed-word emphasis uses an explicit 25% addition/deletion foreground blend over the code background. Other surface mappings are defined, but only the exercised states have acceptance evidence; conflict and diagnostic coverage remains open.
- The real Chromium FileDiff test first failed on the absent adapter (`/tmp/ade-pierre-red.log`) and then on double tinting (`/tmp/ade-pierre-green.log`). It now verifies literal added/deleted Graphite and Chalk fills through browser color rasterization, syntax recoloring in place, retained highlighted-node identity, retained selected-row identity with updated selection color, and unchanged scroll position. Focused result: 1 passed (`/tmp/ade-pierre-selection.log`); intermediate fill result: `/tmp/ade-pierre-fill.log`.
- Pre-bundle Pierre in browser tests to avoid late Vite optimization reloads. Removed its unused-dependency exemption; Fallow validates the updated config. No new dependency version or lockfile change was needed.
- This is adapter evidence, not a replacement for production file/diff acceptance. CodeMirror, complete surface/mapping coverage and production prerequisites remain outstanding.

Pierre slice gate:

- `pnpm check:static`: passed, including 336 renderer tests in 45 files and 863 Rust tests, with 1 existing skip. Log: `/tmp/ade-pierre-static.log`.
- `git diff --check`: passed. The adapter is not yet attached to a production diff surface, so no new built-desktop diff acceptance is claimed. There were no daemon, protocol or settings changes in this slice.
- Ticket 07 remains in progress. Next work is the CodeMirror adapter and the remaining mapping/surface evidence, followed by startup and production integration prerequisites.

2026-09-29 — CodeMirror adapter and mapping limits.

- Checked CodeMirror's official styling/reference guidance (https://codemirror.net/examples/styling/ and https://codemirror.net/docs/ref/) and installed declarations. Searched official agent-resource guidance; the prior llms.txt probe was inaccessible and no official skill was established. Used the documented EditorView.theme, HighlightStyle, syntaxHighlighting, Compartment and darkTheme APIs.
- Promoted existing transitive versions to direct dependencies for actual imports: @codemirror/language 6.12.4 and @lezer/highlight 1.2.4. Added the already-resolved @codemirror/commands 6.11.1 as a test dependency to verify undo through its public API. pnpm install completed without version upgrades (`/tmp/ade-codemirror-deps.log`, `/tmp/ade-codemirror-test-deps.log`).
- Added a color-only CodeMirror extension with separate surface and syntax mappings. It changes no fonts, sizes, document data or editing behavior. Consumers place it in a Compartment and reconfigure the darkTheme facet only when mode changes. Same-mode palette changes update the shared CSS variables without a state transaction.
- The real CodeMirror/Chromium test loads the JavaScript grammar through the installed language-data package, edits a document, records caret and scroll, changes palette and mode, and verifies the same editor DOM/document identity and preserved caret/scroll. Public undo then restores the original document, proving history survives. Initial missing-adapter failure: `/tmp/ade-codemirror-red.log`; focused pass: `/tmp/ade-codemirror-green.log`.
- Pre-bundle the newly used CodeMirror entry points in browser tests to prevent duplicate dependency instances from late optimization. Removed used packages from the unused-dependency exemptions; retain the unused convenience codemirror package exemption until a consumer uses it.

Mapping limits and consumer responsibilities:

| ADE role | Shiki / TextMate | CodeMirror / Lezer |
|---|---|---|
| syntax-keyword | keyword and storage scopes | keyword and operator tags |
| syntax-string | string scopes | string tag and its subtypes |
| syntax-number | constant.numeric scopes | number tag and its subtypes |
| syntax-comment | comment scopes | comment tag and its subtypes |
| syntax-default | unassigned scopes inherit editor foreground | unassigned tags inherit editor foreground; the non-fallback highlighter disables stock fallback coloring |
| diff-add / diff-remove | markup.inserted / markup.deleted | inserted / deleted tags |

TextMate scopes and Lezer tags are different grammar models, not a reversible mapping. Language grammars may classify contextual keywords, operators, regular expressions, interpolations, types and constants differently. Unmapped categories retain the default role; semantic-token rules from an imported VS Code theme are not implicitly implemented by either adapter. The current five-role mapping does not preserve arbitrary per-scope imported styling; importer diagnostics and richer mappings remain later work. Color adapters impose no bold/italic/font changes.

Surface styles use separate code variables for base, selection, gutters, active lines, search and diagnostic borders. Pierre owns its diff layout and later selection/hover layers. CodeMirror consumers retain their existing extensions for search, lint, gutters and selection; defining colors does not create those features. Diagnostic underline decorations and all production surface states still need owning-consumer acceptance. The adapter does not introduce the excluded built-in editor.

CodeMirror slice verification:

- `pnpm check:static`: passed, including 337 renderer tests and 863 Rust tests (1 existing skip). Log: `/tmp/ade-codemirror-static.log`. This includes the Shiki and Pierre adapter regressions, generated-contract checks, package checks, lint, typechecking and production builds after the manifest/lockfile changes.
- `git diff --check`: passed. No daemon/protocol changes or production editor surface was added; no new built-desktop editor acceptance is claimed.
- Accepted the mapping-limits/CodeMirror-adapter criterion: the adapter exists, runs against the real library, and there is no existing production CodeMirror consumer to exercise. All production code/diff, complete surface-state and startup requirements remain open. Ticket 07 and the full theming goal remain in progress.

2026-09-29 — Independent syntax colors before first paint.

- The previous startup cache contained only the active syntax palette. It could not resolve the inactive side of a paired syntax binding after an OS appearance change while ADE was closed. Extended the authoritative ResolvedSyntaxAppearance contract with light_palette and dark_palette, regenerated contracts, and reused the shared resolver with an explicit mode. Valid fixed selections repeat their palette in both slots; follow-app and paired selections resolve each slot independently. Missing selections retain deterministic mode fallbacks.
- Moved the code-role-to-CSS-variable mapping into desktop shared code. Main and live rendering use that one mapping. The blocking startup script applies code variables before the appearance-ready performance mark and browser paint. Without a usable cache, code variables inherit the shipped app tokens. Cache validation now checks syntax variants for complete roles, literal colors and applicable mode slots, including the inactive variant. Cached data remains a committed daemon snapshot; preview does not write it.
- Current-format contract decoding rejects incomplete older snapshots and uses the existing visible startup warning. No legacy cache migration or theme identity guessing was added, following D19.
- Extended the real-process protocol test to require both variants for fixed and paired bindings while preserving persistence, mode switching, stale revision rejection and atomic invalid-input rejection. The initial test failed specifically on absent variant fields (`/tmp/ade-syntax-cache-red.log`); the rebuilt focused test passed (`/tmp/ade-syntax-cache-protocol.log`).
- Built-desktop acceptance warms a committed cache, quits Electron, stops the daemon, and relaunches offline. It checks app/native colors and independent fixed/paired syntax variables at the blocking mark before first paint. A second offline launch uses today's OS mode despite the prior cached resolved mode. Corrupt inactive syntax colors reject the cache, preserve saved choices and expose the startup warning after reconnect. Existing profile isolation and app-color/role corruption tests still pass.
- Added real Shiki fallback coverage: absent committed syntax tokens inherit built-in app tokens without replacing highlighted content. Focused renderer result: 1 passed (`/tmp/ade-syntax-cache-fallback.log`).

Validation:

- pnpm contract:generate and pnpm build:backend: passed (`/tmp/ade-syntax-cache-contract.log`, `/tmp/ade-syntax-cache-backend.log`).
- pnpm check:static: passed on the final source, including 337 renderer tests in 46 files and 863 Rust tests, with 1 existing skip (`/tmp/ade-syntax-cache-static-final.log`). An earlier gate also passed before the default-variable fallback addition (`/tmp/ade-syntax-cache-static.log`); final evidence is the later run.
- pnpm test:e2e:protocol:only e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/syntax-appearance.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts: 22 passed (15.5s), `/tmp/ade-syntax-cache-protocol-final.log`.
- pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts: 29 passed (1.2m), `/tmp/ade-syntax-cache-desktop-final.log`. The focused startup/corruption/syntax run first passed 6 tests (`/tmp/ade-syntax-cache-desktop.log`).
- git diff --check: passed.

Ticket 07 remains in progress. This proves startup variables and committed settings delivery, not production code/diff surface acceptance. The missing production consumers and remaining surface-state coverage recorded above remain open; no additional shared TH row is marked complete.

2026-09-29 — Native selection, conflict and diagnostic surface mappings.

- Rechecked Pierre's official https://diffs.com/llms-full.txt reference and pinned 1.5.1 source. The documentation exposes UnresolvedFile for actual conflict rendering and calls it beta/experimental. Installed CSS uses separate --conflict-bg-current/incoming[-number]-override variables; the ordinary diff overrides did not recolor those regions. The new real UnresolvedFile test failed on its default blended current-region fill (`/tmp/ade-pierre-conflict-red.log`).
- Added current-region fill from diff-add-muted and incoming-region fill from info-muted, including number backgrounds. Added the code info-background variable because this consumer needs the existing info-muted token. Disabled a second tint on conflict rows through the same owned static adapter rule used for ordinary diffs. Incoming number text uses the gutter role; marker labels use syntax-comment. These selectors and variable names are pinned-library seams to recheck on an upgrade.
- Expanded actual Pierre diff coverage for line-number foreground and changed-word emphasis. Both Graphite and Chalk now exercise addition/deletion fills, word fills, gutters, selected rows and unchanged node/scroll state. Expanded conflict coverage checks current/incoming literal fills and marker pseudo-element text while preserving region and marker node identity. Initial expanded word-color expectations were corrected against the actual handed-off palette and the declared 25% sRGB blend; no palette values were changed. Intermediate result is retained in `/tmp/ade-pierre-conflict-green.log`; the corrected two-test pass is `/tmp/ade-pierre-conflict-verified.log`.
- CodeMirror's pinned lint module used fixed-color SVG background images for inline underlines. Existing panel-border mappings did not recolor them. Added theme-colored native wavy text decorations, point-marker colors, active-diagnostic selection, and panel/tooltip foreground/background. Token foregrounds, document data, fonts and editing extensions remain independent. Consumers still own whether lint/search are enabled.
- Added the already-resolved @codemirror/lint 6.9.7 and @codemirror/search 6.7.2 as direct test dependencies with pnpm; no version upgrade. Public setDiagnostics, openLintPanel, openSearchPanel and setSearchQuery APIs create real diagnostic ranges, an error point, panels, search matches and gutters in Chromium. Official CodeMirror reference/styling probes were inaccessible in this turn; prior official guidance and pinned implementation/declarations supplied the API evidence. Browser prebundling includes these modules to avoid duplicate state packages.
- The inline diagnostic test first failed on the fixed red SVG (`/tmp/ade-code-surfaces-red.log`). It now checks all three severity underlines, an error point marker, panel border/base, search fill and gutter foreground under both palettes. The same state object and search/error nodes survive recoloring. Focused two-test pass: `/tmp/ade-code-surfaces-green.log`; expanded four-test CodeMirror/Pierre pass: `/tmp/ade-code-surfaces-focused.log`.
- Shiki's TextMate theme does not supply browser-native selection styling. Added a scoped .shiki ::selection color adapter using the shared selection/selection-foreground variables. The initial selection test failed (`/tmp/ade-shiki-selection-red.log`); the real highlighted token test now checks both pseudo-element colors with its existing retained DOM, text-selection and scroll assertions.

Final validation:

- pnpm --filter @ade/desktop test src/renderer/src/features/code/code-theme.test.ts src/renderer/src/features/code/codemirror-theme.test.ts src/renderer/src/features/code/pierre-theme.test.ts: 5 passed in 3 files, `/tmp/ade-code-surfaces-complete.log`.
- pnpm check:static: passed on final source, including 339 renderer tests and 863 Rust tests, with 1 existing skip (`/tmp/ade-code-surfaces-static-verified.log`). Earlier passing gates before the Shiki selection adapter are `/tmp/ade-code-surfaces-static.log` and `/tmp/ade-code-surfaces-static-final.log`.
- pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts --grep 'syntax settings|embedded website|two windows': 3 passed (6.8s), `/tmp/ade-code-surfaces-desktop.log`. The static gate rebuilt the desktop first. These cover syntax delivery, cross-window settings and embedded-page isolation; they do not prove a production code/diff surface.
- git diff --check: passed. No daemon/public-contract change occurred in this slice; previous real-process appearance evidence remains applicable.

Production prerequisite recheck: tab-content.tsx still renders TerminalContent only. The file-domain tickets identify the missing owners: [workspace files](../../../06-files-git/issues/02-workspace-files.md) covers previews and [diff review](../../../06-files-git/issues/01-diff-review-feedback.md) covers the Electron diff view. Their documents describe intended/partial work; current renderer searches found no file/review or transcript code consumers. F074's broader Verified register entry does not prove an Electron diff surface or TH25. The theming ticket does not implement the excluded editor or silently expand into those domain features. Ticket 07 and its production criteria remain open. The index now names implemented adapters and startup colors accurately; all shared TH rows remain unverified.
