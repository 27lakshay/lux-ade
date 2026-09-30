# 03 — Ship all 12 palettes with system switching and correct startup colors

Status: done
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Choose any handed-off palette and a light/dark pair, follow system appearance, and launch directly into matching native-window and page colors.

**Blocked by:** [01 — Switch Graphite and Chalk across the app and terminal](01-core-switch.md)

**Spec coverage:** TH01, TH03, TH06, TH07, TH31. User stories 1–4, 13–15, 20–24. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] All 12 named palettes preserve the 73 handed-off roles and equivalent normalized sRGB values. Same-mode changes update CSS and non-CSS consumers as one coherent change without color transitions.
- [x] Fresh profiles default to system mode, Graphite dark and Chalk light. App slots validate variant mode rather than inferring it from names.
- [x] The designated desktop owner reports system appearance; headless profiles retain the last observation and use dark/Graphite when none exists. Merely attaching a remote viewer does not change authority.
- [x] A validated per-profile startup cache contains both variants and exact root/window colors. Native appearance and document tokens apply before first paint, including an OS change while the app was closed.
- [x] Cache writes follow committed state atomically. Missing or invalid data uses deterministic defaults and exposes relevant diagnostics; core reset remains usable.
- [x] Embedded website content remains unchanged. Palette choices persist and propagate between windows without leaking across profiles.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Exercise public mode and selection operations, then capture cold-start and relaunch behavior for arbitrary light/dark pairs in built Electron. Test invalid cache and no-observation headless startup.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.


## Comments

2026-09-29 — Started after accepting terminal recovery ticket 02. Current code still embeds only Graphite/Chalk, resolves headless System as dark, and keeps an app-wide startup file containing only mode. Renderer/native appearance can follow the OS independently of the daemon's terminal mode. This ticket must replace those limited paths with validated palette slots, an authorized host observation and a per-profile startup snapshot; no ticket 03 criterion is accepted yet.

2026-09-29 — Complete built-in catalog exposed through the public API.

- Embedded all 12 handoff palettes, each with all 73 literal roles. Added explicit light/dark metadata and stable `ade:` catalog IDs. The existing fixed Graphite/Chalk resolved selection remains unchanged until the selection-pair step.
- Added typed query operation `settings.palettes` and CLI command `settings palettes`; generated contracts from Rust. This query returns each variant's ID, display name, mode and complete token map.
- Extended the build-time fidelity guard to reject missing palette variants as well as changed/missing/extra token roles. Its 5 tests pass.
- Added a real-daemon protocol test comparing every catalog entry with the independent handoff document, then comparing SDK and CLI results. It first failed with unknown operation; after implementation, `pnpm test:e2e:protocol:only e2e/protocol/profiles/palettes.spec.ts` passed (1 test, 9.1s).
- Contract generation and backend build completed. The initial CLI build ran before contract generation finished and rejected the new operation; rebuilding after generation completed resolved that build-order failure. `pnpm typecheck` passed.
- Palette selection slots, desktop catalog controls, OS observation authority and startup-cache work remain unimplemented in this ticket. Catalog availability alone does not satisfy its acceptance criteria.
- `pnpm check:static` passed for the catalog changes, including all 310 renderer tests and 862 Rust tests (1 existing skip). Log: `/tmp/ade-theming-catalog-static.log`. The ticket remains in progress; the catalog's namespaced IDs must be connected to persisted selections and resolved-appearance IDs in the next step.

2026-09-29 — Persisted app palette slots and shared resolution.

- Added app_light_theme and app_dark_theme settings with explicit ade:chalk/ade:graphite defaults. Both accept only known variants whose declared mode matches the slot. Validation precedes the transaction, so a wrong-mode/unknown palette also prevents unrelated preferences in that request from changing.
- A combined mode/pair change increments appearance_revision once; unchanged values remain idempotent. Core reset restores both slots. The runtime projection now comes from the selected palette, and settings.appearance returns the same namespaced identity as settings.palettes.
- Cached built-in catalog metadata once and reused it for lookup and terminal projection. Contracts were regenerated from Rust; CLI settings set accepts the palette keys and documents them in usage.
- Added a real-daemon selection test: set Carbon/Linen, reject a light variant in the dark slot and an unknown ID, switch through CLI, kill/restart the daemon, verify the selected tokens/runtime acknowledgment and reset both slots. It first failed on missing slots. After implementation, `pnpm test:e2e:protocol:only e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/settings.spec.ts` passed all 10 tests (19.2s).
- Desktop controls and applying selected tokens/native window colors are still pending. System mode still uses the headless dark fallback until host observations are implemented. Missing/corrupt selection fallback and the per-profile startup cache remain required; no ticket 03 acceptance row is closed.
- The first full gate found one outdated exact Rust settings-reply fixture missing the new default slot fields (861/862 Rust tests passed). Updated that expected wire shape without changing its equality assertion. Final `pnpm check:static` passed, including 310 renderer tests and all 862 Rust tests (1 existing skip). Log: `/tmp/ade-theming-slots-static-final.log`.


2026-09-29 — Desktop palette controls and committed projection.

- Added stock ToggleGroups for all six light and six dark variants, with selected palette names in the mode controls. Both selections use the shared settings operation and revision checks.
- Added an explicit app mode to resolved appearance, independent of terminal mode. Renderer applies every resolved token, including same-mode changes, with transition suppression. Main applies the matching native background. Profile settings feed changes request the committed projection, including changes from CLI or another window.
- Added revision and connection-generation guards to renderer resolution; delayed replies cannot overwrite a newer applied palette or apply after disposal. Added a renderer regression test for delayed replies and disposal.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts` passed all 10 tests (7.2s). New coverage selects Carbon/Linen through actual controls and compares native/page colors; it also changes Carbon/Midnight/Graphite on a mounted terminal, compares all 73 CSS roles and terminal canvas pixels, and verifies unchanged runtime/run/shell identity. Log: `/tmp/ade-palette-controls-desktop-final2.log`.
- `pnpm test:e2e:protocol:only e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/settings.spec.ts` passed all 10 tests (2.0s). Log: `/tmp/ade-palette-controls-protocol.log`.
- Intermediate validation exposed an outdated renderer fixture missing the appearance query, a fixed-length palette tuple type in the new fixture, an asymmetric hex-case comparison, and a terminal test sampling identity before the newly mounted terminal had painted. Corrected the fixtures/comparison and waited for the initial real canvas paint before capturing identity. Required assertions remain intact.
- System observation authority, per-profile startup snapshots and selected-theme fallback remain unfinished. No ticket 03 or shared TH acceptance row is closed by this partial result.
- Final `pnpm check:static` passed, including 311 renderer tests and 862 Rust tests (1 existing skip). Log: `/tmp/ade-palette-controls-static-final2.log`.


2026-09-29 — System appearance authority and retained observations.

- Reused the existing live local browser-owner registration as the profile's desktop identity. Added typed idempotent operation `settings.appearance.observe`; the server checks the current profile/owner and rejects stale sequence numbers or conflicting reuse of a sequence. Re-registering the same owner preserves its observation fence.
- The daemon stores the last system mode atomically with any effective appearance revision change. System mode resolves the selected light/dark slot from that observation. Explicit light/dark settings remain authoritative. No observation defaults to dark; a retained observation survives headless daemon restart.
- Electron reports observations after owner registration and native-theme updates. It reports only while nativeTheme.themeSource is system, because Electron's shouldUseDarkColors includes explicit overrides. Checked the installed Electron declaration and official nativeTheme documentation: https://www.electronjs.org/docs/latest/api/native-theme. Returning to system also requests an observation even if the resolved native color did not change.
- Observations serialize through the owner and capture mode, sequence, endpoint and daemon boot. Closing the owner removes its listener; queued observations for a replaced endpoint/boot are discarded. A rapid dark/light regression first failed with the daemon stuck dark; removing the previous confirmed-mode suppression and serializing observations fixed it.
- `pnpm test:e2e:protocol:only e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/settings.spec.ts`: 11 passed (2.0s), including owner rejection, sequence conflicts, same-owner re-registration, explicit-mode precedence and headless restart. Log: `/tmp/ade-system-observation-protocol-final.log`. The first run failed because the operation was absent; an intermediate run reached restart and exposed a wrong test-helper name, corrected to restartDaemon.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts`: 11 passed (7.8s), including sequential and rapid system changes reaching real app tokens and terminal canvas through production owner/daemon/runtime code. Only Electron's OS signal is replaced in the test; macOS user preferences remain untouched. Log: `/tmp/ade-system-burst-desktop-final.log`.
- The API parity gate initially required a named CLI command. Added a reasoned exemption alongside browser-owner registration: this operation reports host observations; user appearance changes remain available through settings set. Generic CLI request and the typed SDK retain access subject to owner checks. Validated the parity configuration with `node scripts/api-parity.mjs`.
- Per-profile startup snapshots, before-first-paint verification and missing/corrupt selected-theme recovery remain required. Ticket 03 and its shared acceptance rows remain open.
- Final `pnpm check:static` passed after the rapid-change fix: 311 renderer tests and 862 Rust tests passed (1 existing skip). Log: `/tmp/ade-system-burst-static-final.log`.


2026-09-29 — Per-profile startup snapshots and before-paint application.

- The resolved appearance reply now includes the committed preference and both selected variants, read under the same daemon state lock as the resolved mode/revision. Rust contracts generate the shared wire shape.
- Main caches validated committed replies in profile-keyed files under userData/appearance. Managed profiles use their stable profile ID; fixed sockets use their resolved socket identity. A version/profile envelope, size bound, generated response validator, variant mode/role-count checks and literal color checks reject malformed data. Writes use a private temporary file and atomic rename; renderer preference messages do not write the cache.
- Native window creation and the blocking theme-boot resource choose the same cached variant. System mode reads the current local OS mode instead of reusing the cached resolved mode. The boot resource sets tokens, root background, mode and preference before React loads. A performance mark allows the desktop test to compare appearance application with actual paint timing.
- Main follows committed settings through its daemon subscription even with no open window. Desktop settings mutations refresh the committed snapshot before returning success. Profile/reconnect generation checks discard obsolete refreshes; a fresh daemon reply can supersede a higher cached revision. The renderer also resets its revision comparison on a new connection while rejecting old-connection replies. The reconnect regression failed before this reset and passes afterward.
- Built app reloads request the current profile boot resource from main. Vite startup receives the validated snapshot through preload arguments; refreshing that preload snapshot on a Vite page reload after later palette changes still needs reconciliation before claiming equivalent development reload behavior.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts`: 14 passed (26.1s). Added offline relaunch with Carbon, a required paint-timing entry proving the boot mark precedes paint, system-mode selection from a cached pair whose prior mode/tokens oppose the current OS, separate-profile cache isolation, invalid-color rejection, and CLI-driven Midnight caching with no renderer followed by offline relaunch. Log: `/tmp/ade-startup-desktop-verified.log`.
- The first no-window test checked Playwright's window list before its close event arrived; changed the assertion to await that event through polling. No production behavior or acceptance assertion was weakened.
- `pnpm test:e2e:protocol:only e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/system-appearance.spec.ts`: 11 passed (2.7s). Log: `/tmp/ade-startup-protocol.log`.
- Final `pnpm check:static` passed: 311 renderer tests and 862 Rust tests passed (1 existing skip). Log: `/tmp/ade-startup-static-verified.log`. `git diff --check` passed.
- Remaining ticket work includes missing/corrupt selected-theme fallback and user-visible recovery diagnostics (invalid startup cache currently logs a warning), plus final managed-profile switching, embedded-content and complete acceptance reconciliation. Ticket 03 and shared TH rows remain open.


2026-09-29 — Selection fallback, reset recovery and visible diagnostics.

- Added typed appearance diagnostics for missing themes, wrong-mode selections and malformed stored selection values. Both palette slots resolve independently to their matching Graphite/Chalk fallback; the daemon retains the original stored selection until the user changes or resets it.
- A malformed palette selection no longer prevents settings reads or daemon startup. Reset repairs the stored rows, advances the appearance revision even when the effective fallback already equals the default, publishes the change, and preserves unrelated motion/keybinding preferences.
- Settings displays the daemon's fallback messages. Main exposes local startup-cache warnings separately through the typed preload bridge. Invalid-cache startup warnings remain visible after connection; a successful restore clears the startup warning. Cache write failures retain a separate warning and are not concealed by acknowledging a startup warning.
- Added a real SQLite corruption/restart protocol test covering unavailable IDs, wrong-mode IDs and invalid JSON. It failed before implementation because the daemon exited during startup with Selected app palette is unavailable. After implementation, `pnpm test:e2e:protocol:only e2e/protocol/profiles/appearance-recovery.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/system-appearance.spec.ts` passed all 12 tests (11.6s). Log: `/tmp/ade-selection-recovery-protocol.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts` passed all 15 tests (33.9s). New coverage verifies the missing-theme message, matching fallback page/native colors and restore through the real control. Extended invalid-cache coverage reconnects the daemon, verifies the retained startup warning, and restores defaults to clear it. Log: `/tmp/ade-selection-recovery-desktop.log`.
- Remaining ticket work includes Vite reload startup freshness, final managed-profile switching and embedded-content verification, and complete criterion/TH reconciliation. No shared TH row or ticket 03 completion is claimed here.
- Final `pnpm check:static` passed: 311 renderer tests and 862 Rust tests passed (1 existing skip). Log: `/tmp/ade-selection-recovery-static.log`. `git diff --check` passed.


2026-09-29 — Completed startup parity, managed-profile switching and ticket acceptance.

- Production and Vite now load the same blocking `ade://app/theme-boot.js` resource. Main prefixes the bundled script with the current validated snapshot on every request and disables response caching. Removed the stale preload-argument snapshot. Development CSP permits this specific app origin without adding inline-script permission. The real Vite test changes Carbon to Midnight, stops the daemon, reloads, and verifies that the initial boot mark and page use Midnight.
- A real managed-profile test exposed a connected-to-connected daemon identity change: selecting a lower-revision Linen profile left Carbon on screen. The renderer settings follower now fences queries by daemon boot identity as well as connection transitions and rejects feeds from the previous boot. Browser regressions cover identity changes both with and without an intervening disconnected state; the built app switches Carbon → Linen → Carbon and checks page colors, native colors, stable profile cache keys and saved selections.
- Opened an actual isolated WebContentsView with its own colors and content, changed ADE palettes, and verified unchanged website CSS/content and absence of the app preload bridge.
- Tightened startup validation to require the exact 73-role set generated from the handoff-checked palette source. A regression replaced foreground with an unknown role while retaining the count. Before the fix, startup incorrectly used Carbon; after the fix, it uses deterministic defaults, retains the diagnostic after reconnect, and clears it through the real reset control. Literal-color rejection remains covered separately.
- The first final static run rejected a shadowed window variable in the managed-profile test. Renamed the Playwright page binding; assertions were preserved. The next full gate and 18-test appearance suite passed before the additional cache-role regression. Both the failure and the later complete runs are recorded rather than treating an isolated retry as a full pass.
- Final `pnpm check:static` passed: 312 renderer tests and 862 Rust tests passed, with 1 existing Rust skip. Log: `/tmp/ade-ticket03-cache-static.log`.
- Final `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts` passed all 19 tests (44.8s), against the rebuilt desktop. Log: `/tmp/ade-ticket03-cache-desktop.log`.
- Final `pnpm test:e2e:protocol:only e2e/protocol/profiles/appearance-recovery.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/system-appearance.spec.ts` passed all 12 tests (3.2s). Log: `/tmp/ade-ticket03-protocol-final.log`.
- `node --test scripts/generate-theme-css.test.mjs` passed all 5 fidelity/generation tests; `node scripts/generate-theme-css.mjs --check` and `git diff --check` passed.

Criterion reconciliation:

| Criterion | Acceptance evidence |
|---|---|
| All 12 palettes and coherent switching | Public catalog compared independently with all 876 handoff values; generated defaults checked; mounted same-mode changes compare all 73 CSS roles, terminal pixels and unchanged process identity. |
| Defaults and explicit variant modes | Public settings tests cover fresh defaults, atomic wrong-mode/unknown-ID rejection, persisted pairs and reset. |
| Authorized system observations | Real owner lifecycle, rejected foreign owner, sequence fencing, headless retention/restart; desktop sequential and rapid OS-signal changes reach daemon/native/WASM. |
| Correct per-profile pre-paint startup | Offline cold start checks the boot mark against actual paint timing and native color; cached pair resolves current OS; Vite reload uses the same main resource. |
| Committed cache and recovery | Main receives no-window CLI changes, atomically writes per-profile snapshots, rejects invalid colors/roles/profile envelopes, explains fallback and supports reset after reconnect. |
| Website isolation and profile/window propagation | Embedded website fixture retains its own content/styles; two app windows synchronize; managed profile switching accepts a lower revision without leaking the old palette. |
| Required gates and evidence | Final static, protocol and rebuilt desktop commands above passed. |

All ticket 03 criteria are accepted. This supplies ticket 03's contributions to TH01, TH03, TH06, TH07 and TH31; broader shared-row completion still requires the index's contributing tickets and final reconciliation. The existing Vite configuration emits a future-loader warning about extensionless imports; it does not prevent the actual development reload test. OS observations use an Electron signal fixture and do not change the user's macOS preferences. No scope revision or parent-spec edit was made.
