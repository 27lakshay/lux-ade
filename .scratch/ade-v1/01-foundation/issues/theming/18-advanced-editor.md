# 18 — Edit complete custom themes

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Edit semantic, terminal and syntax values as a local draft and save a validated custom theme without damaging its source.

**Blocked by:** [09 — Manage custom themes and ADE import/export](09-ade-theme-library.md)

**Spec coverage:** TH22. User stories 57, 59, 62. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] An advanced editor exposes supported role names, section types, modes and terminal color values with immediate validation and existing both-mode previews.
- [ ] Editing a built-in starts a custom definition; duplicate, rename, save-as, reset and delete follow existing identity and conflict rules.
- [ ] Drafts remain local until explicit save/apply. Cancel restores the latest committed appearance and leaves running terminal defaults unchanged.
- [ ] Save validates completeness and revision; conflicting edits and persistence errors retain recoverable draft data and explain the failure.
- [ ] A saved custom definition can be selected through desktop or public operations and produces the same app, terminal and code appearance after restart.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Exercise edit/save/reset/conflict flows in built Electron, then inspect/export the saved result through public operations and verify it on real consumers.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Evidence and blockers

- Focused built-desktop integration passed 11 tests in `test-results/runs/desktop-747ed2f5-8d63-4f27-8f03-0867fe869e8a`, covering `theme-editor.spec.ts`, `theme-validation.spec.ts`, `theme-library.spec.ts`, `theme-contrast-inspector.spec.ts`, `theme-contrast-repair.spec.ts` and `theme-linked-file.spec.ts`. The editor exercises app, terminal and syntax fields, immediate malformed-source diagnostics, reset, cancel, independent light/dark previews, a terminal-only preview and editing a large valid source within the UTF-8 input limit.
- The custom-copy scenario saves, validates and installs `user:editor-copy` without altering Graphite or committed appearance. Public `settings.set` then selects all three sections; `settings.appearance` reports the edited app primary, terminal ANSI entry and syntax keyword before and after daemon restart. The reopened renderer exposes the edited `--primary`. These projection/preview checks do not prove actual terminal or code consumers render the saved values after restart.
- Rename and stale-replacement scenarios retain drafts across revision conflicts and require explicit review/revalidation. Complete duplicate/save-as/delete identity flows, cancel against the latest committed appearance with a live terminal, and recoverable editor persistence-error flows remain unverified. Their acceptance rows remain unchecked.
- Ticket 09 remains the shared library/real-consumer prerequisite; ticket 07 production code/diff consumers remain unavailable. Complete app/terminal/code restart acceptance remains blocked by actual terminal/code consumer verification. `pnpm check:static` passed at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`.
