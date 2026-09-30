# 19 — Inspect tokens and report contrast problems

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Identify the role behind an ADE element and inspect the actual foreground/background combinations that make a theme readable.

**Blocked by:** [17 — Apply accessible appearance preferences across the workbench](17-accessible-appearance.md), [18 — Edit complete custom themes](18-advanced-editor.md)

**Spec coverage:** TH22, TH23. User stories 60–61. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Token inspection maps supported visible app-button/menu, Shiki code-preview and terminal states to their distinct semantic roles, source/resolved values and current values even when colors match; production diff consumers remain unavailable and are not guessed.
- [x] The report measures the supported app, Shiki code-preview, Pierre diff-preview and terminal samples, with selected/hover/focus states, thresholds, ratios and alpha compositing; unavailable production diff/code consumers and cell-relative terminal selection remain unavailable rather than asserted.
- [x] Unsupported or unconsumed roles and unavailable mappings are explicit rather than assigned a guessed consumer.
- [x] Following a reported role opens the relevant advanced-editor field and updating a draft refreshes the report.
- [x] Imported and built-in source definitions remain unchanged during inspection. Reports distinguish diagnostics from certification and require explicit edits for repairs.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Use known role/contrast fixtures and built-desktop inspection of real elements. Verify that an edit changes the intended state and that inspection alone causes no persisted mutation.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Evidence and blockers

 - The inspector crosswalks supported button, menu, Shiki, Pierre diff-preview and terminal states to their distinct semantic roles, declared/resolved values and measured contrast. It explicitly leaves production diff/selection/focus consumers and cell-relative terminal selection unavailable; Pierre preview measurements do not certify production consumers. No source colors changed; results remain diagnostics, not WCAG certification.
 - `pnpm --filter @ade/desktop exec vitest run src/renderer/src/provisional/themeContrastInspector.test.ts`: 23 passed. `pnpm --filter @ade/desktop exec vitest run src/renderer/src/features/code/code-theme.test.ts src/renderer/src/features/code/pierre-theme.test.ts`: 3 passed; these consumer Vitests assert Shiki ::selection and Pierre addition/deletion/word preview colors. `pnpm --filter @ade/desktop typecheck` and `pnpm --filter @ade/desktop build`: passed.
 - `pnpm exec playwright test --config playwright.desktop.config.ts e2e/desktop/theme-contrast-inspector.spec.ts --workers=1`: 1 passed. The built desktop flow verified read-only inspection, role-to-editor focus, draft provenance/warnings, syntax selection role mapping, Pierre addition line/gutter and word preview colors, and saturated secondary hover color against Chromium's computed color-mix sRGB channels and rendered surface. It exercised the passing draft repair and verified invalid edits leave installed themes and appearance unchanged. This E2E does not assert Shiki ::selection or Pierre deletion colors; those are covered by the consumer Vitests above.
 - Ticket 17’s destructive foreground change remains blocked pending an approved palette revision. Production diff consumers and cell-relative terminal selection remain unavailable as stated above.
- Integrated Electron appearance/theme smoke passed 43 tests at `test-results/runs/desktop-5e9d141a-21df-4d67-b5aa-37ceb08eab20`, including the contrast inspector, theme editor/library, linked files, plugin theme selection and accessibility/appearance scenarios.
- Independent Chromium CSSOM review confirmed matching pass/fail and repair decisions for saturated and near-threshold contrast cases. Computed browser ratios differ from Culori arithmetic by about 0.0000115; exact arithmetic equivalence is not established.
- `pnpm check:static` passed at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`.
