# 16 — Customize typography, density and terminal cursor behavior

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Persist independent reading preferences for app, code and terminal surfaces while preserving active work.

**Blocked by:** [07 — Theme code blocks, previews and diffs independently](07-code-diff-themes.md)

**Spec coverage:** TH26. User stories 68–70, 73, 77. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] UI, code and terminal font families/sizes are independent, validated profile preferences exposed through desktop, CLI and SDK with readable unavailable-font fallbacks.
- [x] Default/compact density preserves approved shell structure, focus and reachable controls through existing layout tokens.
- [x] Terminal line height, supported font features, cursor shape and blink apply through existing metric/input boundaries. Color-only changes never refit the grid.
- [x] Font changes refit/resize only through the terminal ownership rules and preserve process identity; document, caret and scroll remain intact where geometry permits.
- [x] Preferences survive relaunch and profile backup integration remains assigned to ticket 23. Color imports cannot replace them implicitly.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Test public persistence/validation and built-desktop font fallback, resizing, density and cursor behavior on app/code/terminal surfaces, including a running terminal program.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Comments

- 2026-09-30 — Terminal metric/cursor preferences and preference isolation are implemented. Terminal tests preserve output, caret/selection and scrollback; the built-desktop checks prove persisted controls, live terminal rendering and process identity.
  - `pnpm --filter @ade/desktop exec vitest run src/renderer/src/components/Typography.test.tsx src/renderer/src/app/profile-settings.test.ts`: 17 passed.
  - Terminal renderer tests: 3 files, 79 passed. `pnpm --filter @ade/desktop typecheck` and `pnpm --filter @ade/terminal typecheck` passed.
  - `pnpm test:e2e:desktop:only --grep 'typography settings apply|desktop previews supported Warp colors' --reporter=line`: 2 passed; the Warp case verifies preference isolation through import and daemon restart.
  - `pnpm check:static` passed at `test-results/runs/static-2c7ebd5c-87e9-4de6-97a1-074add6e2c61` (status: passed). An earlier run had one renderer timing failure in the existing workspace sidebar width test; it passed on targeted rerun and the full static run.
  - `pnpm --filter @ade/desktop build`: passed, refreshing the renderer before density E2E.
  - `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts --workers 1`: 34 passed. The density case verified default/compact layout-token values, focus retention and visible workspace, project navigation and settings controls in both modes.
  - Focused post-integration rerun: `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts --grep "density controls preserve" --workers 1`: 1 passed in `test-results/runs/desktop-2aadbdb9-0d88-44b8-8db8-bbb6b45f02f5`.
  - Full appearance module passed in `test-results/runs/desktop-2c77c72d-9c47-4e63-84bf-4bb102f1777e` (34 passed).
  - Updated typography geometry E2E: `typography settings apply to the profile and reattach the running terminal` passed (1 test) in `test-results/runs/desktop-807de775-8d54-4e3b-96fd-b4e2a6186682`. It observes a changed terminal grid, retains the same canvas, run ID, shell PID and terminal byte count, and checks independent persisted UI/code/terminal preferences. This does not prove production code-font rendering.
- `pnpm check:static` passed after final integration at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`.
- Remaining: ticket 07’s production code/diff consumers block complete code-font acceptance. Profile backup behavior remains with ticket 23.
