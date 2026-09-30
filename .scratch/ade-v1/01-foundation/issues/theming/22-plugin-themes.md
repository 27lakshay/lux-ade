# 22 — Support declarative plugin themes and safe-mode recovery

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Install a plugin-provided theme and recover to explained core defaults if the plugin is disabled, removed or unavailable.

**Blocked by:** [09 — Manage custom themes and ADE import/export](09-ade-theme-library.md)

**Spec coverage:** TH07, TH27. User stories 23–24, 74–75. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] An actual plugin contributes validated declarative definitions and token metadata through the existing lifecycle; namespaced IDs prevent collisions.
- [ ] Selection reaches built-in and extension surfaces through stable semantic roles and is available through desktop and public operations.
- [x] Invalid contributions fail before registration without corrupting other definitions. Theme data adds neither arbitrary CSS nor executable theme behavior.
- [x] Disable/removal deletes only the provider contributions and resolves affected selections to same-mode defaults while retaining enough identity for diagnostics.
- [ ] Safe mode exposes core restore-defaults and preserves active work. Re-enabling a missing theme never overrides a later explicit choice.
- [x] Confirm the existing plugin lifecycle prerequisite with real integration evidence; a synthetic theme registry alone does not complete this ticket.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Install an independent fixture plugin through the real plugin path, select its theme in the desktop, then disable/remove/re-enable it and enter safe mode while preserving work.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Comments

2026-09-30: Added declarative theme contributions to plugin manifests, namespace/validator enforcement at install, and activation-owned library synchronization on startup, plugin lifecycle commands and development reload. Plugin theme records carry provider ID, version and artifact digest. Disable, uninstall and unavailable-on-restart remove only live provider contributions; selected missing IDs remain persisted and resolve to the same-mode core palette with diagnostics. Real install-path tests cover later explicit choices, CLI/library visibility, invalid data and namespace collisions.

Evidence: `pnpm contract:generate` completed (with a non-fatal host `rust-objcopy`/missing `libLLVM.dylib` warning); `pnpm contract:check` passed; `node scripts/cargo.mjs test --locked -p ade-daemon --lib plugins::manifest` passed (6 tests); targeted backend/SDK/CLI builds passed; `pnpm test:e2e:protocol:only e2e/protocol/plugins/plugin-themes.spec.ts` passed (4 tests); `pnpm test:e2e:protocol:only e2e/protocol/profiles/theme-library.spec.ts` passed (8 tests). The first combined E2E attempt caught an incomplete staged fixture manifest; after preserving its existing commands/settings/hooks, the complete plugin-theme file passed.

Latest protocol integration: 10 tests passed across the plugin lifecycle, plugin theme fallback/recovery and stale-preview revision suites (`e2e/protocol/plugins/lifecycle.spec.ts`, `e2e/protocol/plugins/plugin-themes.spec.ts`, and `e2e/protocol/plugins/plugin-theme-revisions.spec.ts`). Coverage includes `installed plugin themes validate, resolve, and fall back across the provider lifecycle`, `unavailable installed providers lose their themes on daemon recovery`, `failed plugin fallback propagation is reported and reconciled after runtime recovery`, and `remove and re-add advances plugin theme revisions so stale previews conflict`. No run ID was captured for this latest result. It proves real install/enable/disable/uninstall and public appearance fallback behavior, not renderer selection or safe-mode pixels.

The manifest structural regression `plugins::manifest::tests::unsupported_theme_roles_are_rejected_after_diagnostic_limit` passed in the final `pnpm check:static` run at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`. This does not prove deterministic coverage of the stale contribution-snapshot race, which remains untested.

Lifecycle changes are serialized, and the stale-preview revision E2E passed. No deterministic regression exercises the stale contribution-snapshot interleaving: the public fixture has no coordination signal for that interleaving without a test-only hook. The protocol result therefore does not prove this race is covered; lifecycle/contribution acceptance must not be treated as complete race coverage.

The backend-only evidence did not establish desktop theme selection, built-in/extension renderer pixels, token-metadata consumption, or renderer safe-mode UI. The new desktop scenario exercises plugin app-theme selection and provider ID/version display. Its `?safeMode=1` reload and restore-defaults action preserve live terminal run IDs/PIDs, but the renderer currently has no verified plugin-loading gate and this query-driven scenario does not prove a real renderer-failure recovery. Safe-mode acceptance remains unchecked for this reason. Ticket 09 remains a prerequisite, and Ticket 07 code/diff production consumers remain open. Full project validation passed at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`.

2026-09-30: Added desktop proof for a real declarative plugin theme and safe-mode-parameter appearance recovery in `e2e/desktop/plugin-themes.spec.ts`. The spec stages and installs/enables the independent `e2e.backend` fixture, starts on core Graphite, then selects and applies `plugin.e2e.backend:night-sky` through the Electron Theme library preview. It verifies provider ID/version, the committed `--primary` change, and persisted `settings.appearance` theme ID. The scenario also enters `?safeMode=1`, restores defaults, confirms the terminal ID/run ID/PID remain unchanged and `metrics.shell_running` remains true, then uses Back to workspace to reload without `safeMode` and verifies the workspace and running shell return. This query-driven scenario does not prove plugins are disabled or induce recovery through an actual renderer failure. The main-process recovery dialog describes recovery without claiming plugins are off. `pnpm --filter @ade/desktop typecheck`, `pnpm --filter @ade/desktop build`, and `pnpm test:e2e:desktop:only e2e/desktop/plugin-themes.spec.ts --workers 1` passed (1 test).

The desktop run proves app-theme selection and the provider metadata panel, but the extension/code renderer surface is still absent (Ticket 07); therefore selection row 2 remains unchecked. Safe-mode row 5 remains unchecked: the view is exercised by adding `?safeMode=1`, but plugin loading is not gated and a real renderer failure was not induced. Tickets 09 and 07 remain explicit blockers for their broader acceptance rows. Plugin lifecycle/validation/fallback evidence above covers rows 1, 3, 4 and 6. The stale contribution race and full ticket are not claimed complete.
