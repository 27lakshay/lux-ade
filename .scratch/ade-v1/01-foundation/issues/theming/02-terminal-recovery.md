# 02 — Preserve terminal appearance through recovery and races

Status: done
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Reopen or reconnect to a running terminal and retain its latest colors, program overrides and process identity, even when appearance changes race with output.

**Blocked by:** [01 — Switch Graphite and Chalk across the app and terminal](01-core-switch.md)

**Spec coverage:** TH03, TH14, TH15, TH16, TH29. User stories 22, 25, 36–39, 41–42, 77. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Attachment and recovery carry the appearance revision and rendering metadata needed by every view. Output, changes and snapshots are ordered so an older feed cannot revert a newer appearance.
- [x] Changing appearance while WASM initializes applies the latest requested value after initialization and restoration. Hidden views paint the latest state when shown.
- [x] Two views agree after detach, reattach, resync and daemon replacement while the runtime and terminal process remain alive.
- [x] OSC foreground/background/cursor and indexed overrides survive default changes and snapshot restoration; reset sequences reveal the new defaults. No theme change replays PTY history or input.
- [x] Concurrent selections, snapshots and slow consumers settle on the authoritative revision or expose a pending/failed state. Selection and scroll survive color-only updates.
- [x] The same-pin native/WASM snapshot contract remains intact; any metadata extension is tested through the actual attachment path.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Extend native/WASM viewer and built-desktop recovery scenarios with a real terminal program, delayed initialization and deterministic races. Assert revisions, queries, rendered cells and unchanged process identity.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Comments

2026-09-29 — Recovery and initialization evidence; ticket remains in progress.

- Two real WASM views retain OSC foreground/background/cursor and palette-index-200 overrides through a Graphite-to-Chalk change, detach/reattach and daemon replacement. The runtime instance, terminal run IDs and terminal byte counts remain unchanged. The surviving program queries the native colors and light mode, then resets overrides; both views expose the latest Chalk defaults while literal truecolor stays unchanged.
- A second protocol test captures actual attachment snapshots and appearance frames, validates them through the SDK decoder, and delivers them to the production TerminalFeed and WASM core in delayed order. Older appearance events cannot replace a newer snapshot. An older recovery snapshot stops the feed with an explicit reconnect message and retains the newer colors.
- The built desktop test holds the browser's real WebAssembly instantiation, changes dark/light selections three times, then releases compilation. The new terminal paints the final Chalk background and reports applied propagation. The runtime instance and pre-existing shell/run identities remain unchanged. The newly opened terminal starts on attachment after initialization, so it adds one runtime terminal; it is not an existing process to compare before release.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance-recovery.spec.ts`: 2 passed (2.0s).
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts`: 6 passed (6.8s), including the new delayed-initialization case and the earlier persistence, mounted repaint, propagation failure, reset and two-window cases.
- Initial test attempts exposed test-harness issues: Playwright routing did not intercept ade:// WASM assets; browser callbacks accidentally referenced the outer Page variable; the before/after terminal-list assertion incorrectly assumed no new attachment would start a terminal. These were corrected without changing production behavior. Typechecking also required the existing SDK decoder for captured untyped fixture frames.
- Still required: hidden-view repaint, slow-consumer resync during appearance changes, selection/scroll preservation, and review of attachment event filtering and the local theme setter. These tests do not close a shared TH acceptance row.
- Final `pnpm check:static` passed after the test corrections, including formatting, lint, TypeScript, contract/boundary checks, build, JavaScript/browser tests and 862 Rust tests (1 skipped). Log: `/tmp/ade-theming-recovery-final-static.log`. The earlier attempt failed TypeScript on unvalidated fixture frames; that failure is resolved by decoding them through the public SDK.

2026-09-29 — Hidden views, interaction preservation and overloaded attachments.

- Built-desktop tests hold the existing canvas element while its tab is detached and its backing canvas freed. After a committed appearance change, returning to the tab reconnects that same element and paints Chalk; runtime and shell/run identities stay unchanged.
- A real scrollback interaction and mouse drag select numbered terminal output. A color-only change preserves the selected copy text, scrollbar offset, shell/run identity and terminal byte count. The copy handler is exercised with an in-memory ClipboardEvent without changing the system clipboard.
- A worker running the production SDK, TerminalFeed and WASM core deliberately exceeds the runtime viewer queue. Three selections made while output is queued converge on the final appearance revision after resync. Its colors, screen and output offset agree with a fresh attachment; the original shell remains alive.
- A new protocol regression first failed because terminal_appearance was broadcast to subscribers that requested terminal: false. The runtime now classifies appearance alongside output and resize as terminal-only events. A ping barrier proves those subscribers receive no appearance frame after the command completes.
- Removed the unused mounted-view setTheme entry point. Attached terminals receive changes through the authoritative feed; the rendering surface still applies those colors. This removes a local path that could disagree with native queries. Snapshot application supplies current defaults after asynchronous surface creation.
- `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts e2e/protocol/terminals2/appearance-recovery.spec.ts e2e/protocol/terminals2/resync.spec.ts`: 13 passed (47.4s), 1 existing fixme skipped. That fixme concerns a CLI complete-history replay exceeding its write timeout, not the new appearance-resync scenario; its known connection failure is not claimed fixed.
- Initial hidden-tab test attempts used an ambiguous tab locator and an empty-state-only New terminal button. The test now selects the actual workspace tab and switches through New conversation. These were test-navigation corrections. Typechecking required explicit canvas types. Removing the local setter exposed a dead-code analyzer inference limitation; an explicit surface type and feed adapter retain the real call without a suppression.
- `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts`: all 8 tests passed (12.6s) against the rebuilt desktop after the feed/filter changes.
- Added a real concurrent-writer test: dark and light commands race with the same expected revision while a second view attaches. Exactly one commits, the other returns appearance_conflict, native propagation reports the winning revision, and both views converge without a status error. `pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance-recovery.spec.ts`: all 4 passed (1.7s).

Acceptance audit for this slice:

| Criterion | Evidence |
|---|---|
| Revisioned attachment and recovery ordering | Actual SDK-decoded snapshots/live frames; delayed events ignored and stale recovery fails visibly. Concurrent selection/attachment test proves convergence. |
| Initialization and hidden views | Built Electron holds real WASM instantiation; multiple selections resolve to the latest. Detached canvas returns with committed colors. |
| Multiple views and surviving processes | Two-view daemon replacement and slow-consumer resync tests preserve run identity; fresh and recovered views agree. Desktop checks retain shell PID. |
| Program overrides, resets and output | Native queries and both WASM views retain foreground/background/cursor/indexed overrides through replacement. Resets expose Chalk; truecolor and byte counts remain unchanged. |
| Races, selection and scroll | Concurrent-writer conflict test, output-queue resync with three selections, and actual mouse selection/scrollback test. Saved-but-unconfirmed propagation remains visibly tested in the desktop suite. |
| Same-pin snapshot contract | Real runtime binary snapshots are restored by the pinned WASM core through the SDK/TerminalFeed path, including overloaded recovery. |

This completes ticket 02's contribution to TH03/TH14/TH15/TH16/TH29 once the final static gate below passes. Shared rows remain unverified in the index pending their full contributing-ticket reconciliation; terminal bindings and workload thresholds remain tickets 04 and 24.
- The final static attempt after adding the concurrent-writer test hit the known unrelated Workspace sidebar width failure (751.546875 vs 752 at Workspace.test.tsx:36). All 250 pure JS tests and the other 309 renderer tests passed. An unchanged isolated run of `pnpm --filter @ade/desktop exec vitest run src/renderer/src/features/workspace/Workspace.test.tsx` passed all 4 tests (3.57s). A full gate retry is required; the isolated pass does not replace it. The sidebar assertion was not weakened and sidebar production code was not changed.
- A full-gate retry then failed with ENOTEMPTY during journal-test scratch cleanup. Inspection found openClientJournals used fail-fast Promise.all while its parallel owner-file creation could still be writing. It now waits for all openers to settle before returning an error. Added a regression that synchronously reads the completed owner file immediately after rejection. All 251 pure JS tests passed, including that regression; the journal preservation assertions remain unchanged.
- The next full gate reproduced the same 0.453125px sidebar drift. Inspection found the settling hook ignored differences up to 0.5px. Tightened only that settling tolerance to 1/64px; the exact-width test remains unchanged. These are prerequisite gate repairs discovered during acceptance, not additional theme capabilities.
- The tighter sidebar tolerance did not fix the full-suite failure: the same 751.546875px result recurred in `/tmp/ade-theming-ticket02-settle-static.log`. Reverted that attempted production change. The tolerance explanation alone is insufficient; sidebar diagnosis remains required. All 251 pure tests passed, including the journal regression, but the latest full gate is failing at the renderer width assertion. Ticket 02 remains in progress and no acceptance completion is claimed.

2026-09-29 — Sidebar gate diagnosis and correction.

- Captured the failed DOM state: navigator 260.1875px, inspector 340.265625px and centre 751.546875px instead of saved widths 260/340 and centre 752. Gutters were already 8px and no layout animation attribute remained.
- Inspected the installed react-resizable-panels pixel conversion: Panel.resize divides by the sum of each panel's integer offsetWidth. During settling that sum can be one pixel short; individual corrections therefore use the wrong denominator. Changing only the error tolerance did not address this feedback.
- Settling now restores the complete group from its measured content width minus gutters, in one setLayout call. It retains the existing centre/sidebar minimum rules and cancels its timer on unmount. Removed temporary diagnostics; Workspace.test.tsx and its exact-width assertion remain unchanged.
- `pnpm --filter @ade/desktop exec vitest run`: all 310 tests passed (18.98s) with the group-level correction. The subsequent full gate also includes the narrow-window minimum handling and timer cleanup.

- Final `pnpm check:static` passed: 251 pure tests, 310 renderer tests, and 862 Rust tests with 1 existing skip. Log: `/tmp/ade-theming-ticket02-group-static.log`. The explicit feed adapter made two old Fallow suppressions stale; removed those comments and reran `pnpm deadcode`, which reports no issues (`/tmp/ade-theming-suppression-cleanup.log`).
- Final rebuilt desktop run: `pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts`, all 8 passed (51.1s), including hidden views, delayed initialization, selection/scroll preservation and native-window updates. Log: `/tmp/ade-theming-ticket02-final-desktop.log`.
- Ticket 02 accepted after this full-gate pass. Prior failed attempts remain recorded above. Shared TH rows and the overall 24-ticket objective remain open.
