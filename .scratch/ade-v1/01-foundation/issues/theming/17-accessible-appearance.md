# 17 — Apply accessible appearance preferences across the workbench

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Use reduced motion, high contrast and visible focus across the workbench while preserving non-color cues and embedded website appearance.

**Blocked by:** [03 — Ship all 12 palettes with system switching and correct startup colors](03-palettes-system-startup.md), [05 — Render complete terminal cursor and selection colors](05-cursor-selection.md), [07 — Theme code blocks, previews and diffs independently](07-code-diff-themes.md)

**Spec coverage:** TH23, TH26, TH31. User stories 15, 61, 71–72. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Explicit preferences and available OS signals govern reduced motion, high contrast, reduced transparency and non-color differentiation; durable settings use the common public operations.
- [ ] Check all built-in palettes on actual app/code/diff/terminal combinations: normal text at 4.5:1 and essential non-text/control identification at 3:1, including translucent destructive and focus states.
- [ ] Focus stays visible at full and kit opacity; status uses labels or icons as well as color. Contrast calculations do not claim full WCAG certification.
- [ ] A failing handed-off combination records its roles and requires an explicit palette revision before acceptance. Preserve approved source colors until that revision; do not waive the check.
- [ ] General contrast changes semantic roles with recalculated checks rather than a whole-window filter. Custom theme diagnostics preserve source colors; terminal correction remains separately controlled.
- [ ] Keyboard operation and motion preferences remain effective through switching and preview. Embedded browser content keeps its own styles.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Combine deterministic browser contrast checks with built-desktop keyboard, focus, OS/preference and non-color-cue scenarios. Record measured failing combinations rather than accepting a screenshot alone.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Evidence and blockers

- The three new profile preferences persist through the common settings operation and update the renderer. The built desktop E2E selected On for each, observed all three root accessibility attributes, then selected Off for high contrast and observed the saved value and removed attribute (`test-results/runs/desktop-de80ec67-29f9-4785-9a87-e036c8e21157`).
- The native accessibility bridge reports high contrast, reduced transparency and differentiate-without-color signals as `boolean | null`; native event and profile-settings tests cover signal updates, explicit overrides, and unsupported values. Contract generation/checks, core and daemon tests, and the protocol settings persistence/isolation E2E passed in their focused runs.
- `ProjectTree` exposes textual Idle/Running/Needs you/Error labels; `.status-visible-name` now reveals supplementary status text when `data-differentiate-without-color` is enabled, without changing the role’s accessible name or color. Rail status has an outline rule, but no live `needsYou` caller. `pnpm --filter @ade/desktop exec vitest run src/renderer/src/components/Status.test.tsx src/renderer/src/app/profile-settings.test.ts`: 7 passed. The visual non-color cue is exercised in the renderer test; the complete workbench mode matrix remains open.
- Palette audit: dark `Button` destructive text uses `--destructive` over a translucent `bg-destructive/30` hover. It measured 3.764–4.373:1 across dark palettes over `background`, `card` and `popover`, below the 4.5:1 normal-text target. This requires an explicit palette revision before acceptance; source palette colors remain unchanged. Existing contrast tests cover selected semantic pairs, not this complete matrix or a WCAG certification. The user chose “Keep blocked”: preserve the approved values and current component treatment; do not revise the palettes.
- Ticket 07 remains incomplete, so actual code/diff surfaces and their terminal combinations cannot be verified. The keyboard/motion-through-preview and embedded-browser portions remain unverified for this ticket.
- Latest focused status-label/settings Vitest result: 7 passed across `Status.test.tsx` and `profile-settings.test.ts`; no run ID was captured. This proves the tested labels and preference behavior, not the full focus/opacity, OS-signal or workbench contrast matrix. The destructive foreground defect remains blocked by the user’s “Keep blocked” decision.
- `pnpm check:static` passed after integration at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`. The full focus/opacity, OS-signal and workbench contrast matrix remains incomplete; the destructive foreground defect remains blocked by the user’s “Keep blocked” decision.
- A focused real-Chromium regression reproduced inline theme tokens defeating ordinary stylesheet overrides. High contrast now strengthens semantic border/ring roles and `border-input` controls without changing `--input`, which remains the source for translucent fills. Tests compare input-fill rendering with high contrast on/off in light and dark modes, check control borders against foreground, and verify a focused button retains its 2px outline without changing its destructive surface. `pnpm --filter @ade/desktop exec vitest run src/renderer/src/app/accessibility-preference.test.ts src/renderer/src/app/profile-settings.test.ts src/renderer/src/components/Status.test.tsx`: 11 passed.
