# 20 — Generate themes from a surface and accent

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Create an editable complete theme draft from a base surface and accent, with both-mode previews and visible contrast results.

**Blocked by:** [19 — Inspect tokens and report contrast problems](19-token-contrast-inspector.md)

**Spec coverage:** TH22, TH23. User stories 58, 61–62. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Simple authoring derives a complete normalized draft using the existing color library and explicit semantic mappings; generated values never inherit from the previously visible theme.
- [ ] Both-mode previews and the contrast report expose the generated choices before saving. The advanced editor can inspect and change every generated role.
- [x] Contrast repair is an explicit action that creates an edited draft and recalculates checks; original imported/built-in values remain intact.
- [ ] Reset, cancel and save-as retain the shared identity/revision semantics. A saved draft applies through normal desktop/public selection and survives restart.
- [x] Generated drafts make no accessibility-certification or Pen-approval claim; extended-palette harmonization remains excluded.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Verify deterministic derivation and gamut handling in pure tests, then create, inspect, save and select a draft through built-desktop controls and public export.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Evidence and blockers

- The generator derives every app role from the explicit surface, accent and mode inputs, normalizes output to sRGB, rejects invalid/translucent inputs and does not read the visible theme. The resulting app-only custom definition passed common theme validation; installation and desktop/public selection are explicit. The latest pure helper suite `src/renderer/src/provisional/simple-theme.test.ts` passed 14 tests. The prior built-desktop generator flow passed 2 tests (`test-results/runs/desktop-9513db72-232d-44dc-8ffe-d613351a2dc7`).
- Generated definitions intentionally leave terminal ANSI and syntax roles out; the UI disclaims accessibility certification.
- Combined built-desktop integration passed 11 tests at `test-results/runs/desktop-747ed2f5-8d63-4f27-8f03-0867fe869e8a`, including generator installation/public selection and persisted generated app tokens/CSS after daemon restart, the contrast inspector, and `repairs contrast only in an unsaved custom Graphite draft`. Explicit repair changes a local custom foreground from 1.00:1 to at least 4.5:1, refreshes diagnostics, and leaves Graphite, the library and committed appearance unchanged. It does not change the approved destructive action treatment.
- Shared editor light/dark previews, role editing, reset and cancel are now exercised by ticket 18. The generator’s `ThemeValidationPanel` still produces source for validation/installation without opening those both-mode previews or the contrast report before saving. The generated-draft handoff and complete generated reset/cancel/save-as identity flows remain unverified, so those combined criteria remain unchecked.
- Ticket 19’s complete consumer matrix and ticket 07/09 production code/terminal consumers remain prerequisites for complete restart appearance acceptance; public projections and app CSS do not prove those consumers. `pnpm check:static` passed at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`.
