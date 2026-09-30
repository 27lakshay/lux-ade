# 23 — Back up and restore appearance with profiles

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Restore a profile with its theme definitions, selections and reading preferences even after original import files disappear.

**Blocked by:** [09 — Manage custom themes and ADE import/export](09-ade-theme-library.md), [16 — Customize typography, density and terminal cursor behavior](16-fonts-density-cursor.md), [22 — Support declarative plugin themes and safe-mode recovery](22-plugin-themes.md)

**Spec coverage:** TH08. User stories 13, 22, 26. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Current-format backups include installed custom definitions/provenance, selected app/terminal/syntax bindings, terminal overrides, favorites/recents and appearance preferences.
- [x] Restore into a scratch profile resolves identical supported values without import source files and without leaking another profile’s appearance.
- [ ] Unavailable plugin theme sources use the documented core fallback with explanatory diagnostics; restoring appearance does not install executable plugins implicitly.
- [x] Corrupt/incomplete theme records and unsupported formats fail according to current backup validation, with no false complete-restore claim. D19 excludes legacy migration chains.
- [ ] Restored data produces matching desktop startup, code surfaces and terminal queries/rendering through existing consumers; verify the real backup prerequisite before claiming completion.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Export a populated profile through public backup operations, remove source files, restore into a separate scratch profile and launch built Electron. Compare definitions, preferences, fallbacks and visible/native appearance.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Evidence and blockers

- Extended `e2e/protocol/backup/restore.spec.ts` with a real-process public-API round trip for a custom theme carrying author/license provenance and app, terminal, and syntax values. The test selects it with non-default accessibility, typography, density, cursor, and terminal override settings; removes the original source before backup; restores into a separate profile; restarts the daemon; and checks the restored definition/provenance and resolved values. The source and an unrelated profile remain unchanged.
- `pnpm test:e2e:protocol:only e2e/protocol/backup --workers 1` passed 22 tests at `test-results/runs/protocol-b51c3823-2b38-4254-9650-27e1bd9f628d`. Read-only review found no actionable defect. No backup implementation change was needed: current-format database backup already preserves these records.
- `pnpm test:e2e:protocol:only e2e/protocol/backup/corrupt.spec.ts --workers 1 --reporter=line` passed after the validator was restored: `protocol-78f3240d-8336-403f-b40b-2ee53a22ad3c`. The single real-process test exercises 14 damaged/unsupported bundle cases, including a database row missing `definition.name`; both `backup inspect` and `backup restore` reject, with no restore target or stage left behind. Negative proof removed only the new validator call, rebuilt `ade-control`, and produced false inspect success (exit 0) for the incomplete theme at `protocol-3cc09f34-5597-4cfc-b0b1-3e34b56cc795`; the backup manifest integrity metadata was refreshed, so rejection was specifically theme-schema validation.
- Remaining: theme favorites/recents have no profile-owned state or public operations (ticket 12’s offline catalog is still unbuilt), so backup preservation cannot yet be exercised; do not add renderer-only substitute state here. Unavailable-plugin fallback diagnostics remain blocked by ticket 22. Desktop/code/native-terminal consumers remain unverified and depend on tickets 07/09. Full typography/density acceptance depends on ticket 16. `pnpm check:static` passed at `test-results/runs/static-2c0a6d18-1c3f-493e-994b-be4df553c892`.
