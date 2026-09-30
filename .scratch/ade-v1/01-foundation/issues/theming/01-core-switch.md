# 01 — Switch Graphite and Chalk across the app and terminal

Status: done
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Choose Graphite or Chalk through desktop controls or public operations and see the app and live terminals adopt the same persisted profile appearance.

**Blocked by:** None — can start immediately

**Spec coverage:** TH01, TH03, TH11, TH13, TH14, TH28, TH29. User stories 1, 3, 5, 13–14, 22, 25, 30, 34–38, 76–77. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] A profile stores a stable theme selection and a validated complete resolved appearance. Graphite and Chalk preserve the handed-off values. The resolver remains independent of React, Electron and the DOM; each role has a consumer or an explicit pending consumer.
- [x] Desktop, CLI and SDK can inspect, select and reset the two palettes through the same typed operations. Selection is idempotent; stale revisions and persistence failures leave committed state intact and expose useful errors.
- [x] Two profiles remain isolated and two windows in one profile observe committed changes. Closing and reopening the desktop retains the selection.
- [x] New native terminals receive defaults before programs can query them. Mounted WASM views receive identical resolved palette bytes, including all 256 entries and pinned defaults for omitted indexes; custom extended entries are exercised through a protocol fixture.
- [x] Native color and scheme queries reflect the selection; supported change notifications have one responder. WASM never sends duplicate replies. Live changes preserve OSC overrides and literal truecolor; resets expose current defaults.
- [x] Theme changes preserve process identity and keep terminal bytes outside React state. Appearance revisions expose pending or failed runtime propagation instead of reporting false success.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Prove selection and errors through real daemon/runtime protocol tests, then operate the desktop controls and compare visible app/terminal colors with native query results. Recovery races belong to ticket 02.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Comments

2026-09-29 implementation in progress. Graphite/Chalk defaults now propagate from persisted profile mode to the native Ghostty core, terminal appearance frames and attached WASM views. Generated desktop CSS uses the same literal palette source. Built-desktop controls select light/dark appearance and update native window colors. This is partial implementation; the criteria above remain unchecked.

Evidence collected:

- `ADE_E2E_WORKERS=1 pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts`: 2 passed. Actual settings clicks persist both modes, native/document backgrounds agree, relaunch retains selection, and an existing terminal canvas repaints without changing runtime or terminal run identity. Inspected the captured Chalk and Graphite settings screenshots.
- `ADE_E2E_WORKERS=1 pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts`: 2 passed. Real PTY programs observe Chalk foreground/background and light scheme. An OSC foreground override survives a dark-to-light switch in native replies and the mounted WASM view, restores into a second attached view, and resets to Chalk's current default. These tests contribute to TH13/TH14/TH15; they do not prove the entire rows.
- `pnpm check:static`: latest completed attempt failed with 308/310 renderer tests passing. The new Settings query exposed a missing QueryClientProvider in the routing fixture; supplied the normal provider and seeded settings for that routing test. The row-hover assertion sampled the beginning of its existing 100ms transition; it now waits for the exact expected settled fill. The targeted router/Row retry passed all 6 tests. Full gate rerun is pending; the isolated retry is not full-gate acceptance.

Remaining ticket 01 work includes stable public theme identities and resolved appearance, reset and revision-conflict operations, visible runtime convergence state, multi-profile/window acceptance, custom extended palette fixtures and supported scheme-change notifications. Full override/truecolor coverage remains pending. System-mode observation and the other ten palettes belong to ticket 03. No whole TH row is marked complete by this evidence.

Full-gate follow-up: `pnpm check:static` passed after the fixture corrections, including all 310 renderer tests and the legacy Rust suite. The earlier failing attempt remains recorded above. This validates the current partial implementation, not the unchecked ticket criteria.

2026-09-29 scheme-notification progress: a real PTY regression first failed because selecting Chalk emitted no mode-2031 notification. The native owner now checks the program's reporting mode, encodes the scheme report through the pinned Ghostty API, and flushes it through the existing bounded PTY reply queue after a light/dark transition. WASM adds no responder. `ADE_E2E_WORKERS=1 pnpm test:e2e:protocol:only e2e/protocol/terminals2/appearance.spec.ts` then passed all 3 tests (4.1s), including the previous color-query and OSC override cases. This contributes to TH13; disabled reporting, duplicate/retry behavior and hidden/detached notification coverage still need explicit acceptance evidence.

Notification follow-up: `pnpm check:static` passed, including 310 renderer tests and 862 Rust tests (1 skipped). Extended the protocol scenario to disable mode 2031 before a second mode change and verify that the program then receives only its explicit input byte. All 3 protocol tests passed again (3.7s). Duplicate/retry and hidden/detached notification coverage remain pending.

2026-09-29 revision-conflict progress: `ProfileSettings` exposes the persisted `appearance_revision`. `settings.set` accepts `expected_appearance_revision`; a mismatch rejects the entire request with `appearance_conflict`, current/expected revisions and `reload_settings` recovery. Selecting the same mode preserves its revision. Desktop selections send the displayed revision and refresh after an error without hiding the error. The CLI accepts a validated numeric revision through its existing settings command. Contracts were regenerated from Rust.

Evidence: the added protocol test first failed against the previous daemon because revision metadata was absent. After implementation, the combined settings/terminal appearance suite passed 6 tests. The extended settings suite then passed all 3 tests, exercising successful CLI retry, stale CLI rejection, atomic rejection of a mixed appearance/motion request and revision persistence through daemon replacement. Runtime convergence reporting, theme identities and reset remain unfinished. This contributes to TH28/TH29 without closing either row.

Revision validation follow-up: `ADE_E2E_WORKERS=1 pnpm test:e2e:desktop:only e2e/desktop/appearance.spec.ts` passed both built-desktop tests (9.0s). `pnpm check:static` passed all stages, including 310 renderer tests and 862 Rust tests (1 skipped). `git diff --check` passed. This verifies the current revision-check slice; no ticket criterion or whole TH row is closed yet.

2026-09-29 resolved appearance and propagation progress: added the typed query `settings.appearance` and matching CLI command. It returns the stable Graphite/Chalk ID, literal token map, complete terminal defaults, desired revision and propagation state derived from an actual runtime response. Equality with the complete saved terminal projection establishes `applied`; differing runtime state reports `pending`; an unreachable runtime reports `unavailable`. The runtime rejects a profile appearance older than its current revision even when no terminals exist.

Settings reads this operation, shows unconfirmed terminal updates and provides a retry. If persistence succeeds but runtime propagation fails, the mutation error explicitly says the appearance was saved. This distinction preserves durable state without presenting runtime failure as a failed save.

Evidence so far: the new query test failed against the old implementation. The five settings protocol tests then passed, including real runtime death, a saved selection while runtime was unavailable and convergence after daemon/runtime replacement. All three built-desktop appearance tests passed (7.9s), including actual controls producing a saved-but-unconfirmed message and an enabled retry action after killing the scratch runtime. The first static attempt stopped at the existing workspace sidebar width assertion (751.546875 versus 752); 309/310 renderer tests passed. No assertion was weakened; an isolated retry and a fresh full gate are running. Reset, extended palette acceptance and remaining multi-window/recovery criteria are still open.

Propagation validation follow-up: the isolated workspace retry passed all 4 tests without changing the assertion. The fresh full gate passed all 310 renderer tests and Clippy; its Rust test stage is still running. The extended settings protocol suite passed all 5 tests (7.2s), now also comparing the named CLI `settings appearance` result against the protocol result. Do not treat the unfinished full gate as passed.

The full propagation static gate completed successfully: all stages passed, including 310 renderer tests and 862 Rust tests (1 skipped). This supersedes the earlier pending-run note, while retaining the recorded failing sidebar attempt.

2026-09-29 restore-defaults progress: added `settings.appearance.reset` as an idempotent command requiring the current appearance revision, a named CLI `settings reset-appearance REVISION` command and the stock desktop restore-defaults button. Reset uses the shared settings persistence and runtime propagation path. It restores the currently implemented core mode default without changing reduced motion or keybindings; repeating reset at the current revision leaves the revision unchanged. The operation will grow with the remaining appearance selections in later tickets.

The new protocol test first failed because the operation did not exist. All 6 settings tests then passed (13.4s), including stale reset refusal, preservation of unrelated preferences, CLI retry and acknowledged runtime defaults. All 4 desktop appearance tests passed (9.3s), including a real reset-button click. The static gate caught an unvalidated `unknown` revision at the Electron IPC boundary; added explicit safe nonnegative integer validation. The new full gate passed typechecking and is still running. Additional profile-isolation and two-window tests are also in progress. System-mode OS observation remains ticket 03 work; the current headless resolver defaults to Graphite.

Reset/isolation follow-up: the expanded settings suite passed all 7 protocol tests (8.1s), including two separate real profile daemons/runtimes remaining isolated through selection and reset. All 5 built-desktop appearance tests passed (14.7s). The new two-window test selects Chalk in one window and Graphite in the other, verifying both document backgrounds and both native window backgrounds. The full static gate passed all 310 renderer tests and continues through Rust checks. These results contribute to TH03/TH28; catalog definitions, complete profile backup and other contributors remain open.

2026-09-29 terminal acceptance expansion: all 4 appearance protocol tests pass (4.4s). A headless CLI submits a real program and inspects its replies before any WASM rendering view mounts. A program subscribed to mode 2031 receives a mode change while its rendering view is detached; disabling reporting prevents further unsolicited replies. The palette scenario queries every index 0–255 through the PTY, compares the native reply digest with the daemon projection, and checks every corresponding WASM cell. Independent literal samples cover omitted cube/gray entries. It installs a program override at index 200, switches theme, verifies the retained native/WASM override, resets it and verifies the new defaults. Literal RGB text remains unchanged throughout. This proves custom program overrides above 15; custom imported theme defaults above 15 still need their own fixture.

The first headless-inspection attempt failed because it searched base64 replay JSON for plain text. Reused the existing replay decoder, then reran all four tests successfully. Typechecking passed. The full reset static gate also passed all stages (310 renderer tests, 862 Rust tests, 1 skipped); a final gate for the expanded test file follows. Marked the profile/window/relaunch criterion complete using the recorded real-process and desktop evidence; the ticket remains open.

Persistence-failure evidence: all 8 settings protocol tests passed (8.9s). A trigger in the scratch profile database rejects the appearance-revision write inside the real transaction. Public reads show that appearance, revision and motion all remain unchanged and runtime propagation remains at the old projection; removing the fault permits the same expected-revision retry. No production fault hook was added. Typechecking passed after this test. Marked the public-operation/error criterion complete. Also marked process identity/propagation reporting complete: the built-desktop canvas test preserves runtime/terminal identities, runtime failure is visible through the public projection and Settings, and source inspection confirms terminal frames go directly from the bridge into TerminalFeed, outside React state. These checkboxes do not close the shared TH rows.

The expanded full static gate passed (310 renderer tests, 862 Rust tests, 1 skipped). A final gate including the latest persistence test is running; retain that distinction until it finishes.

### Core palette validation and token consumers

For this two-palette slice, the persisted profile mode selects the stable `graphite` or `chalk` definition. The headless resolver returns all 73 literal roles and a complete 256-entry terminal projection; configurable light/dark pairs remain ticket 03. The generation/static check now compares every bundled role and value against the approved handoff before emitting CSS. Its tests reject changed colors, missing roles and extra roles, including when generating fresh CSS. The tests first failed against the old generator and now all 4 pass. No palette values were changed.

The 73 roles have these consumers or explicit pending consumers:

| Roles | Consumer and status |
|---|---|
| `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `destructive-foreground`, `border`, `input`, `ring`, `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring`, `base`, `panel` (29) | Desktop shell and stock kit semantic CSS aliases; sidebar variants consume their aliases where mounted. |
| `attention`, `attention-muted`, `running`, `success`, `destructive-muted` (5) | Desktop status and semantic feedback aliases. |
| `terminal`, `terminal-foreground`, `terminal-cursor`, `terminal-ansi-0` through `terminal-ansi-15` (19) | Shared native/WASM terminal projection; `terminal` also supplies the desktop terminal surface alias. |
| `terminal-selection` (1) | Pending full selection rendering in ticket 05. |
| `diff-add`, `diff-add-muted`, `diff-remove`, `diff-remove-muted`, `syntax-keyword`, `syntax-string`, `syntax-number`, `syntax-comment`, `syntax-default` (9) | Diff aliases exist; production code/diff integration is pending ticket 07. |
| `success-muted`, `info`, `info-muted`, `link`, `destructive-button-bg` (5) | Pending feedback/link/action-surface mappings and accessible appearance work in ticket 17. |
| `chart-1` through `chart-5` (5) | Stock chart aliases are exported. Production chart consumers remain pending; this theming specification does not add a chart feature. |


### Ticket 01 acceptance audit

Accepted 2026-09-29 for its fixed Graphite/Chalk vertical slice. `pnpm check:static` passed, including the 4 new handoff-validation tests, all 310 renderer tests and 862 Rust tests (1 skipped). The combined settings/terminal protocol command passed all 12 tests (9.9s). The built-desktop appearance suite passed all 5 tests (14.7s); subsequent edits added validation/tests and did not change the desktop composition.

The remaining boxes are supported as follows: the profile's saved mode resolves stable core IDs and all 73 approved values, with every role accounted for above; native defaults are set before spawning the PTY child; native and mounted WASM agree on every indexed color, including a custom program palette entry above 15; headless queries, detached notifications, override resets and truecolor preservation pass against real processes. Earlier comments describing open work are retained as the implementation history.

This closes ticket 01 only. TH01/TH03/TH11/TH14/TH29 still require their other contributing tickets. Custom imported theme defaults above 15 belong to the Ghostty/import acceptance in ticket 10; the core protocol fixture here exercises a custom program override. Configurable pairs and OS observations are ticket 03. Recovery ordering, hidden/initializing views and broader OSC snapshot coverage continue in ticket 02. No aggregate feature or parent acceptance row is claimed complete here.
