# 04 — Choose independent terminal themes and per-terminal overrides

Status: done
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Keep terminals coordinated with the app or choose separate paired/fixed colors, including an override for one terminal.

**Blocked by:** [03 — Ship all 12 palettes with system switching and correct startup colors](03-palettes-system-startup.md)

**Spec coverage:** TH02, TH15, TH28. User stories 5–7, 39–40, 76. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Profile terminal binding supports follow-app, independent light/dark variants and one fixed variant through desktop, CLI and SDK.
- [x] A fixed dark terminal inside a light app reports dark through native queries and renders the selected terminal colors in every view.
- [x] Overrides belong to terminal records, persist when the same terminal record restarts, and survive view/tab changes. Reset returns the terminal to profile binding.
- [x] Profile changes update following terminals but retain explicit fixed overrides. All views of a terminal agree on its effective appearance and revision.
- [x] Invalid selections and stale updates are rejected visibly; responses identify selected IDs, resolved mode, provenance and fallback state.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Use two terminals and two views of one terminal to prove all binding combinations through public operations and desktop controls. Check native queries as well as visible colors.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.


## Comments

2026-09-29 — Started after ticket 03 acceptance. The runtime currently owns a single profile default and broadcasts it to all live terminals. First slice adds a durable profile binding through settings and the existing native/WASM path; per-terminal records and their overrides remain the next required slice.

- Added typed ThemeBinding choices: follow_app, paired light/dark IDs, and a fixed theme_id. The daemon validates IDs and paired variant modes before mutation, persists the selection with the appearance revision, and restores follow_app through core reset. App mode and app tokens remain independent of the terminal projection.
- CLI settings set accepts terminal_binding as JSON, validated by the same generated request contract. The desktop uses stock settings controls for all three choices and their palette slots. Electron forwards the binding through its typed settings bridge.
- The new real-process test first failed because settings.set rejected the unknown setting. After implementation it verifies a fixed Graphite terminal inside a Chalk/Linen app, native OSC foreground and dark-scheme replies before mounting a view, two WASM views, a paired selection through CLI, validation failures, restart/reattachment and reset.
- The first post-implementation protocol run incorrectly expected the low-level openView fixture to reconnect after a daemon restart. That fixture exposes a single attachment; the test now explicitly reattaches for restart verification and tests live two-view switching before the restart. All original color assertions remain.
- The desktop regression caught Electron silently omitting terminal_binding from its forwarded request. Added the field to both the bridge contract and main handler. The first static gate also found the router's seeded settings fixture lacked the new binding; updated the fixture without changing its workspace-preservation assertion.
- Per-terminal overrides, terminal-record persistence, targeted runtime updates, provenance/fallback replies and complete ticket acceptance remain unfinished. No ticket 04 criterion or shared TH row is closed by this partial slice.

- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts` passed 17 tests (8.5s). Log: `/tmp/ade-binding-protocol-final.log`.
- The first full desktop run passed the new binding control test but failed an older same-mode identity assertion: it captured the existing canvas before the asynchronous New terminal operation completed, then saw an additional runtime terminal. The test now waits for a newly selected terminal ID before sampling identity; unchanged run IDs and shell PIDs remain required. The binding control test uses the same explicit readiness condition.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts` then passed all 20 tests (58.5s). Log: `/tmp/ade-binding-desktop-verified.log`. After adding the explicit readiness condition to the binding test, its targeted rerun also passed (1 test, 2.7s; `/tmp/ade-binding-control-verified.log`).
- `pnpm check:static` passed with 312 renderer tests and 862 Rust tests (1 existing skip); log `/tmp/ade-binding-static-final.log`. `pnpm typecheck` passed after the test readiness edits. The final full gate for the exact state after the test readiness edits also passed: 312 renderer tests and 862 Rust tests, with 1 existing skip. Log: `/tmp/ade-binding-static-verified.log`. `git diff --check` passed.

2026-09-29 — Terminal-record overrides and complete runtime projection.

- Added revision-checked `terminal.appearance.set` (idempotent command) and `terminal.appearance.get` (query), with named CLI commands and generated SDK contracts. A binding is stored on the existing terminal record; explicit null returns it to the profile binding. The record change and appearance revision commit in one transaction. Queries return selected/resolved IDs, mode, profile/terminal provenance, fallback diagnostics and propagation state.
- The runtime now receives a complete profile default plus overrides keyed by durable terminal ID. It applies each terminal's effective defaults before spawn and on profile changes, and restores the map from the daemon on reconnect. Projection comparison includes overrides so an acknowledged profile default cannot conceal an unconfirmed override.
- Shared binding validation rejects unknown IDs and wrong-mode paired variants. Resolution retains an unavailable selected ID and reports a matching core fallback. Existing app selection diagnostics also flow through explicit follow-app terminal bindings.
- The initial real-process override test failed on the absent operation. After implementation, it passed two terminals, two views of the overridden terminal, stale edits, profile changes, detach/reattach, daemon replacement and restarting the same terminal record. Extended it with native OSC/scheme replies before view attachment and CLI/SDK inspection/reset parity.
- The parity test caught a schema mistake: `schemars(required)` removed null from the binding schema. Moved the existing nullable-field helper from the layout contract to the shared contract module and reused it. A contract regression requires explicit null to validate and rejects omission; the daemon also rejects omission before mutation. Generated contracts now expose `ThemeBinding | null`. During that helper move, an import placed before module documentation failed compilation; corrected its position before rebuilding.
- The built-desktop override test proves that the selected terminal remains Graphite while the app changes to Linen, reset adopts the profile colors, and runtime/run/shell identity is preserved. It uses the public SDK; terminal-specific desktop controls are still pending.
- Full desktop testing found the earlier readiness wait still used DOM IDs before the initial terminal rendered. These creation-sensitive tests now read the authoritative terminal catalog before clicking New terminal and wait for a selected ID outside that set. The process-identity assertions remain intact.
- Review found a retirement edge: deleting a never-started overridden terminal left its runtime map entry, causing propagation to stay pending. A real-process regression reproduced pending after successful close. Runtime retirement now removes that entry, including when no process ever started.
- Before the retirement fix, 22 protocol tests and 21 desktop tests passed, and the full static gate passed 312 renderer tests and 863 Rust tests (1 existing skip). Those runs are `/tmp/ade-overrides-protocol-verified.log`, `/tmp/ade-overrides-desktop-verified.log` and `/tmp/ade-overrides-static-final.log`. Final post-fix validation is recorded below when complete.
- Remaining ticket work includes terminal-specific desktop controls, visible conflict/fallback handling and complete criteria reconciliation. This ticket and its shared TH rows remain open.

Final post-retirement-fix validation:

- `pnpm check:static`: passed, including 312 renderer tests and 863 Rust tests (1 existing skip). Log: `/tmp/ade-overrides-static-verified.log`.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts`: 23 passed (5.2s). Log: `/tmp/ade-overrides-retire-protocol.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts`: 21 passed (43.0s). Log: `/tmp/ade-overrides-retire-desktop.log`.
- Contracts, backend, SDK, CLI and desktop were rebuilt. `git diff --check` passed. No ticket or shared TH row is closed; desktop override controls and remaining failure/acceptance cases are next.


2026-09-29 — Accepted terminal override controls and ticket 04.

- Added stock provisional desktop controls to choose a terminal, inherit its profile binding, explicitly follow the app, choose independent light/dark variants or keep one fixed variant. The typed Electron bridge uses the same public get/set operations as CLI and SDK. Controls submit the observed appearance revision and refresh after success or failure.
- The selected terminal exposes effective mode, provenance, resolved palette, missing-definition diagnostics and propagation state. A missing selected ID remains visible until reset. Failed or pending propagation can be retried without replacing the saved binding.
- Built-desktop tests now operate the actual controls. They verify fixed Graphite while the app switches to Linen, reset, explicit follow-app distinct from a fixed profile binding, paired Chalk/Carbon choices, native Canvas colors and unchanged runtime/run/shell identity.
- A stale-edit test pauses only the scratch Electron stream bridge while a real public settings mutation advances the revision. The real daemon rejects the stale desktop edit; the UI explains the conflict, refreshes the committed state and permits retry. The bridge resumes in finally. No production response is mocked.
- A missing-definition test seeds a current-format terminal binding in the scratch database, restarts the real daemon, checks fallback metadata, and resets through the desktop while retaining the terminal ID.
- Negative protocol cases cover unknown IDs, wrong-mode pairs, malformed binding kind, omitted binding, foreign workspace, missing terminal and stale/future revision. Each rejects the operation and leaves the committed resolved appearance unchanged. The CLI returns a nonzero result with a machine-readable error.
- Strengthened the two-view test to wait for both views to receive the committed revision before asserting that fixed override colors remain unchanged. The first final static run caught an unknown-typed frame access in this assertion; added explicit object/revision narrowing and reran the complete gate.
- The initial desktop control test failed because the selector did not exist. After implementation, all three control/recovery tests passed. Final integrated evidence below supersedes earlier partial runs.

Final validation:

- `pnpm check:static`: passed, including 312 renderer tests and 863 Rust tests, with 1 existing Rust skip. Log: `/tmp/ade-ticket04-static-verified.log`.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/profiles/settings.spec.ts e2e/protocol/profiles/palettes.spec.ts e2e/protocol/profiles/system-appearance.spec.ts e2e/protocol/profiles/appearance-recovery.spec.ts`: 24 passed (9.4s). Log: `/tmp/ade-ticket04-protocol-verified.log`.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts e2e/desktop/appearance-dev.spec.ts`: 23 passed (49.8s). Log: `/tmp/ade-ticket04-desktop-verified.log`.
- `git diff --check`: passed.

All six ticket criteria now have evidence across the profile-binding, record-override and desktop-control slices above. TH02, TH15 and TH28 remain unverified until their other contributing tickets and shared acceptance reconciliation are complete. Custom definitions and imports remain in their owning later tickets; this slice selects the twelve built-in palettes. The parent specification is unchanged.
