# e2e-plugin-dev

Status: returned
Type: slice evidence
Branch: claude/wf_59b7ac6e-d6c-4
Worker: ADE parallel build, E2E round 4, slice plugin-dev
Requirements: F060, F139 (backend parts advanced, not accepted); 04-S11 (dev-reload leases, advanced)

## Outcome

New headless E2E in `e2e/protocol/plugin-dev/` covers every development-mode
behaviour that the phase 2 slice verified only statically:

- the forced end of a drain after 15 s, including a frozen host;
- the 10 s debounce cap;
- the reload refusals;
- the `unchanged` reload;
- uninstall refused while a host drains;
- leased provider workers and artifacts kept across a reload and a daemon crash.

The specs found no product bug; every run passed as written. Nothing in the
product changed.

Neither F060 nor F139 is accepted. Their register criteria have UI parts:

- F060: reload a UI extension, and recover a frozen UI plugin through a fresh renderer.
- F139: React UI reload, a safe Electron main restart, and component previews.

Those parts need Electron E2E, which is paused. Every backend part of both
criteria now passes as E2E.

## Acceptance criteria

Specs are under `e2e/protocol/plugin-dev/` unless another path is given.

| Requirement | Criterion part | Spec | Result |
|---|---|---|---|
| F060 / F139 | Reload a backend extension by generation; the old call finishes on the old host | `plugins/dev-reload.spec.ts` (round 1) | pass |
| F060 / F139 | Bounded drain: a call still open at the 15 s grace is cut off as `outcome_unknown`, its replay never reruns it, `deactivate` still runs, the log tail names both drain steps, and the old generation retires and loses its artifact | `drain.spec.ts` "a call still open when the drain grace ends…" | pass |
| F060 / F139 | Uninstall is refused with `conflict` while a superseded host drains; it succeeds once the drain ends | `drain.spec.ts` "a call still open…" | pass |
| F060 / F139 | Bounded drain with a frozen superseded host that cannot answer `deactivate`: the host is stopped, the call is unknown, and the new generation serves throughout | `drain.spec.ts` "the drain stays bounded when the superseded host is frozen…" | pass |
| F060 / F139 | Reload rules: a copy equal to the artifact is `unchanged`, both on entry and after a touch; a source that names another plugin ID is `refused`; a lower data schema is `refused`; a higher one is accepted and stored, and it cannot then be lowered; the current generation serves through each refusal | `reload-rules.spec.ts` "an unchanged copy changes nothing…" | pass |
| F060 / F139 | Development mode needs an enabled plugin from a local directory (a package install is refused) and a debounce of 50 to 10 000 ms; entering again retunes the debounce; disabling ends development mode, and enabling again does not resume it | `reload-rules.spec.ts` "development mode accepts only…" | pass |
| F060 / F139 | A source that never goes quiet reloads at the 10 s cap (`reload_due_at` is reported); a retuned debounce applies at once | `reload-rules.spec.ts` "a source that never goes quiet…" | pass |
| F060 | A source directory that disappears is shown as `watch_error` while the current generation serves; when it returns, the reload runs | `reload-rules.spec.ts` "a source directory that disappears…" | pass |
| F060 / F139 / 04-S11 | Leased sessions survive a reload: the leased Conversation keeps its running worker (same PID) and its artifact; a new Conversation gets the new generation in a new worker; a data-schema rise is refused while leased; after a daemon crash both generations stay leased, the old Conversation runs v1 from its kept artifact, and development mode resumes and still refuses the schema rise | `leases.spec.ts` | pass |
| F060 | Failing backend safe mode and recovery; frozen host; bounded log tail | `devplug/plugin-recovery.spec.ts`, `devplug/dev-recovery.spec.ts` (round 3) | pass (re-run here) |
| F060 | Reload a UI extension; recover a frozen UI plugin through a fresh renderer | none | not covered (Electron E2E paused) |
| F139 | React UI reload, safe Electron main restart, component previews | none | not covered (Electron E2E paused) |

## Product fixes

None were needed. The specs found no defect.

## Operation tiers

No operation was added or changed.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/plugin-dev plugins/dev-reload.spec.ts devplug/dev-recovery.spec.ts devplug/plugin-recovery.spec.ts --repeat-each 2`:
  30 passed, 0 failed, in 2.3 min.
- `pnpm check:static`: pass.
- In-process tests added: none.
- `pgrep`: no `ade-daemon`, `ade-runtime` or `security` process from this worktree was running after the runs.
- The specs make no Security framework, `security` tool or `hdiutil` calls.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 5 | 20 | 0 |

## References

- lux-ade `.scratch/ade-v1/evidence/phase2-plugin-dev-reload.md`: its "Verified only statically" list is what these specs cover.
- lux-ade `.scratch/ade-v1/evidence/e2e-plugins.md`, `e2e-devplug.md`: earlier coverage, not duplicated.
- None copied from reference repos.

## Open

- **Unreachable refusal.** The dev-reload refusal for another plugin's
  registration cannot be reached through a manifest.
  - A plugin ID is `publisher.name`.
  - Every command and panel ID must be `<plugin id>.<local name>`, and a
    local name has no dots.
  - Two plugins therefore cannot claim the same ID.
  - `Registry::refusal` is defensive only, so no E2E covers it.
- **Discarded racing copy.** A copy that races a write (`Moving`) is not
  forced deterministically. The cap spec's writer loop may hit it now and
  then; the spec allows for one extra cap window.
- **Known limit, unchanged.** If the new generation's host fails to activate,
  the old host is already draining. The plugin then waits for the next fix
  or for `plugin.host.restart`. `devplug/dev-recovery.spec.ts` shows this.
  Keeping the old host serving until the new one activates would be a
  design change.
- **Leases never end on their own.** Only uninstall releases a provider
  lease. An old Conversation therefore holds its generation and artifact
  until the plugin is uninstalled. `release_provider` has no caller in
  sessions. This is not a defect under the current spec. The coordinator
  may want a lifecycle rule for it.
- Requirement IDs whose full register acceptance now passes: none. F060 and
  F139 wait on Electron E2E.
