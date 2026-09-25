# lux-ade implementation task list

Status: In progress. The full production and open-source plan remains the scope.

Source: [Production and open-source plan](production-and-open-source-plan.md)

Only mark an item complete after implementation and relevant verification. Public release decisions are deferred by the user; local engineering continues.


## 1. Establish the product and architecture rules

- [x] GPUI renders the desktop interface.
- [x] The daemon owns durable application state and application operations.
- [x] The runtime supervisor owns long-lived terminal and provider processes.
- [x] Provider adapters may remain in JS/TS where official SDKs make that the practical choice.
- [x] Chat uses a robust GUI for every provider. No GUI/TUI switching or session handoff. Users can run provider CLIs independently in a terminal.
- [x] New tabs and splits start empty, offering Conversation, Terminal, and Browser.
- [x] Browser resources start only through explicit user action.
- [x] Multiple windows are a first-class capability.
- [x] Customization is general-purpose, without embedding the maintainer’s personal Worktrunk configuration or workflow.

- [x] Verify gate: these rules guide module ownership, tests, and UI behavior without contradictory implementations.

## 2. Make the project independently buildable

- [x] Establish a standalone repository layout.
- [x] Pin the Rust toolchain and document supported macOS versions and architectures.
- [x] Replace external `../../work/...` assumptions with reproducible dependency setup.
- [x] Pin native dependencies and patched GPUI revisions.
- [x] Keep required patches reviewable, with their purpose and upstream status recorded. See [vendor patch ledger](vendor-patches.md).
- [x] Separate generated binaries, caches, logs, screenshots, and runtime data from source.
- [x] Resolve packaged assets from the installed application rather than development paths.
- [x] Provide consistent bootstrap, development, test, and release commands.
- [x] Use pnpm for JS/TS provider packages.
- [x] Supply a fake provider so contributors can exercise the interface without credentials or paid requests.

- [ ] Verify gate: a clean checkout on another supported Mac can build, test, and launch lux-ade using documented commands.

## 3. Organize the Rust code around real responsibilities

- [x] Separate core, client, daemon, runtime, and platform source ownership into workspace crates.
- [x] Enforce dependency boundaries against the resolved Cargo graph.
- [x] Isolate the native terminal surface and AppKit child-window guards in the optional platform feature.
- [x] Keep executable entry points small and group client behavior by feature.
- [x] Finish chat orchestration extraction while preserving state and focus behavior.

- [x] Verify gate: core logic can compile and test without GPUI or Ghostty, and the daemon can build without desktop UI dependencies.

## 4. Define state ownership and background-task lifetimes

- [ ] Give each task an owner and a cancellation policy.
- [x] Use bounded queues with explicit overflow behavior.
- [ ] Keep database access, subprocess operations, and expensive parsing off the UI thread.
- [ ] Reject stale results using request identifiers or generations.
- [ ] Release subscriptions and native resources when their owners close.
- [x] Preserve supervisor-owned processes when their views close.
- [ ] Define shutdown order and deadlines.

- [ ] Verify gate: closing a pane or window leaves no orphaned UI tasks, and late responses cannot update the wrong conversation.

## 5. Make errors understandable and recovery deliberate

- [x] `thiserror` for errors that callers must classify.
- [x] `anyhow` for contextual propagation at application entry points and orchestration code.
- [x] Typed protocol errors with stable codes.
- [ ] Separate user-facing messages from diagnostic details.
- [x] Correlate client, daemon, runtime, and provider activity for Conversation RPCs through a diagnostic ID, Agent run ID, and provider PID.
- [x] Rotate and bound local logs.
- [x] Sanitize diagnostic fields.
- [x] Replace discarded provider stderr with a bounded, privacy-aware diagnostic policy.
- [x] Preserve release symbols separately for useful crash investigation.
- [x] Make diagnostic export explicit and inspectable.

- [ ] Verify gate: important failures produce an actionable UI state and enough safe diagnostic information to investigate them.

## 6. Standardize the dependency set

- [x] Retain GPUI/GPUI Kit, serde, rusqlite, Ghostty, and portable-pty.
- [x] Add thiserror and structured tracing dependencies.
- [x] Use proptest for generated dock operation invariants.
- [x] Evaluate conditional Tokio/tokio-util adoption: retain current workers/executors until a demonstrated I/O ownership need; see [dependency decisions](dependency-maintenance.md#conditional-runtime-and-native-binding-decisions).
- [x] Evaluate objc2 at each current native seam; retain existing bridges with explicit migration triggers in [dependency decisions](dependency-maintenance.md#conditional-runtime-and-native-binding-decisions).
- [x] Evaluate Insta selectively; structural layout invariants currently provide stronger checks than randomized snapshots.
- [x] Establish rustfmt, Clippy, nextest, and cargo-deny checks in CI and verify them locally.
- [x] Record upstream guidance and maintenance findings without hiding transitive debt.

## 7. Build a coherent frontend foundation

- [x] Typography and text hierarchy: repeated sizes and shared component roles are centralized.
- [x] Colors and contrast: semantic palette and enabled-text contrast checks cover normal, hover, and selected surfaces.
- [x] Spacing and sizing: shared component layouts use the GPUI Kit scale and common reading widths.
- [x] Borders and corner radii: the theme and shared component helpers own recurring treatment.
- [x] Icons: shared GPUI Kit icons, with labeled icon-action helpers.
- [ ] Focus, hover, pressed, disabled, loading, and error states.
- [ ] Animation durations and easing.

- [ ] Verify gate: a visual adjustment happens in shared components or tokens, and new screens reuse established behavior.

These foundation items cover shared definitions, not a complete visual or accessibility audit of every screen. Focus/state behavior and motion still need broader native verification before the stage gate can pass.

## 8. Bring chat and workspace interactions to parity

- [ ] Reliable text selection and copying.
- [ ] Markdown, code blocks, highlighting, and copy actions.
- [ ] Attachments and composer behavior.
- [ ] Tool activity, results, approvals, and questions.
- [ ] Queueing, cancellation, retry, and recovery.
- [ ] Long-history performance and predictable scrolling.
- [ ] Clear loading, empty, disconnected, and failed states.
- [ ] Tabs, splits, drag-and-drop, resizing, zoom, and restoration.
- [ ] Predictable keyboard focus and shortcuts.
- [ ] Independent windows and drafts.
- [ ] Lazy browser lifecycle.
- [ ] Correct behavior when native terminal or browser views overlap menus and dialogs.

- [ ] Verify gate: the complete workflow works with the fake provider and representative real providers, including failure paths.

## 9. Add restrained animations and transitions

- [ ] Hover and press feedback.
- [ ] Menus and popovers.
- [ ] Sidebar visibility.
- [ ] Tab insertion, removal, and settling.
- [ ] Empty-pane-to-content transitions.

Pointer-triggered New tab and pane launcher choices now give the tab label a finite 120 ms opacity transition. Keyboard actions, restoration, tab switching, streaming content, and native terminal/browser surfaces remain immediate. Focus and content mounting do not wait for the transition. Unit tests verify completion and Reduce Motion interruption; native visual and frame-timing validation remain pending, so the motion gates above are not marked complete.
- [ ] Restrained progress indicators.

- [ ] Verify gate: motion improves orientation without delaying input or regressing frame timing.

## 10. Establish macOS quality and automated verification

- [ ] Keyboard navigation, shortcuts, text selection, and input methods.
- [ ] Clipboard, file drops, context menus, and notifications.
- [ ] Accessibility labels, screen-reader behavior, and visible focus.
- [ ] Display scaling, window resizing, multiple displays, and multiple windows.
- [ ] Sleep/wake and connection recovery.
- [ ] Main-thread requirements and native resource cleanup.

- [ ] Verify gate: CI catches meaningful regressions, and native checks cover behavior that unit tests cannot prove.

## 11. Prepare the open-source project and releases

- [ ] Choose the project license after reviewing dependency and reused-code obligations.
- [ ] Include third-party notices and provenance.
- [x] Document setup, architecture, contribution flow, testing, and [troubleshooting](troubleshooting.md).
- [x] Add a short Rust guide for JS/TS contributors.
- [x] Explain where to change a component, provider, command, protocol message, or migration.
- [x] Establish versioning and compatibility rules for client, daemon, runtime, and stored data.
- [ ] Produce packaged release artifacts with signing and notarization.
- [ ] Choose and test an update mechanism, including interrupted updates and recovery.
- [ ] Verify releases on a clean supported machine.

## What we carry forward from the clones

- [ ] Ghostex: event-driven chat state separated from rendering.
- [ ] Herdr: control traffic protected from heavy terminal rendering.
- [ ] Paseo: explicit connection lifecycle and pending-request cleanup.
- [ ] T3Code: safe diagnostics and scoped client state.
- [x] OpenCode v2: enforced UI/server dependency separation.
- [ ] Orca: explicit tab, group, focus, and workspace behavior.
- [ ] Oh My Pi: provider-aware error classification and retry policy.
- [ ] Record provenance for actual reused code, distinct from design inspiration.

## Execution order

Portable build and diagnostics → source ownership and lifetimes → shared UI →
representative workflow → native quality and motion → public release tooling.
Keep each step buildable. A partial implementation does not satisfy a stage gate.

## Cross-cutting deliverables

- [x] Extract and verify the proposed core, client, daemon, runtime, and platform crates.
- [ ] Apply the dependency decisions table after checking current upstream guidance.
- [ ] Run the complete representative workflow with fake and real providers.
- [ ] Verify every test layer and every clone-derived pattern in the source plan.
- [ ] Audit each numbered stage against the full source plan before completion.

## Evidence log

- Initial inspection: project is one Cargo package; native dependencies and scripts depend on the surrounding work directory. No stage has passed its completion gate yet.

### First implementation checkpoint

- Created five workspace crates with actual source ownership; client cannot depend on daemon/runtime implementation. `scripts/check_architecture.py` passed against Cargo's resolved graph.
- Initialized local Git repository; no commit or public remote created.
- Core contracts build without GPUI/Ghostty. Daemon checks without UI dependencies. Full workspace check passed with 98 Rust tests, strict Clippy, architecture checks, and six bootstrap tests before the subsequent lifecycle/property additions.
- Checksum-verified native sources and patches rebuilt successfully from an independent download in `/tmp/ade-clean-bootstrap`; another Mac and hosted CI remain unverified.
- Added safe typed transport/client data errors, bounded diagnostic logging and explicit export. Provider and client fault tests passed; full error taxonomy and task lifecycle work remain.
- Added component preview states, shared tokens, Reduce Motion refresh, and sidebar entrance. Native visual verification and broader motion work remain.
- Added contributor/source map documentation, packaging, local release scripts, and CI definitions. Source relocation and packaged application verification remain in progress.
- Public repository ownership, license choice, and signing credentials deferred by user. No publishing/signing completion claimed.

### Native and packaging checkpoint

- Release build with debug information passed; packaging exported UUID-matched symbols, stripped bundle copies, and generated a build manifest. Nine packaging tests passed.
- New release binaries passed the local chat demo and mixed-provider fixture regression across Codex, Claude, OpenCode, and Oh My Pi.
- Native demo verified approval jump, denial returning to Ready, and opening a terminal from the empty split. Component studio state selection was verified through accessibility. These checks do not prove screen-reader completeness or all native interactions.
- Client queues now have count and byte limits, control traffic has a separate worker, save coalescing preserves fences, and subscriptions/recovery polling use weak ownership. Fifteen focused lifecycle tests passed; documented remaining limitations are in task-lifetimes.md.
- Generated dock tests passed 48 sequences with up to 47 operations each. The later nextest run reported 103 tests before the final native-platform changes; final combined rerun remains required.
- Native terminal ownership moved into ade-platform behind native-ui; client tests and independent backend check validate the separation.
- Documented protocol, schema, and local replacement rules in compatibility.md. Public updater and clean-machine signed release remain incomplete.

### Robustness and contributor checks

- The combined Nextest run passed 127 tests with none skipped. Strict workspace Clippy passed after removing a redundant closure. Sixteen Python bootstrap/packaging tests passed. Doctests and dependency-boundary checks passed.
- Dependency checks pass with seven visible unmaintained transitive packages; no advisory IDs are ignored. Known security, yanked-package, and unknown-source findings remain blocking.
- Bootstrap now checks archive/patch fingerprints and verifies legacy source trees against pristine extraction. Regression tests cover Git parent-repository discovery silently skipping patches.
- Provider staging is approximately 69% smaller by preserving validated internal pnpm links. Relocated Claude/OMP fixtures passed 49 tests; native bindings remain included. Python, Node, Bun, and external provider CLIs remain documented runtime prerequisites.
- Chat code fences now expose exact-payload copy and seven language grammars. Rendered copy and actual syntax-span tests passed. Combined GPUI patch reproduces all nine modified source files from its pinned archive.
- Shared failure/recovery categories cover identified provider and save boundaries without automatic replay of uncertain operations. Some legacy local-validation and persistence surfaces remain unclassified.
- Startup now opens a loading window without waiting for catalog I/O. Controller and socket operations have total deadlines. Window close retains its original editor until saves succeed. Native verification of this combined build remains pending.

### Native recovery and measured performance

- The final combined pre-follow-up check passed 127 Rust tests, strict Clippy, architecture checks, doctests, and 16 Python tests. Mixed Codex/Claude/OpenCode/Oh My Pi regression passed after preserving the original-session-unavailable error classification.
- A deliberately stalled daemon left the startup window responsive. In a packaged native demo, code copying preserved the exact code payload and syntax colors rendered. Disconnecting the daemon, editing a draft, and closing the window retained the original editor. Reconnecting and selecting Retry save and close completed the save and closed the window.
- The one/four-window performance run with 2,000 history entries and repeated reconnects passed the existing budgets. Steady-state UI timer lateness p95 was 5.08/8.11 ms; provider-to-render entry p95 was 43.94/49.94 ms; control round-trip p95 was 0.89/2.38 ms. Client peak RSS during the streaming phase was 142.69/201.84 MiB. These are local benchmark results, not product SLAs or cold-launch measurements. Native terminal stream output matched exactly.
- Follow-up source changes retain unacknowledged drafts beyond pane/workspace teardown and move shortcut saves off the UI thread. Their focused checks pass; the next combined release check must include those changes.

- Architecture rules audit: process/crate ownership agrees with the implementation; no GUI/TUI switch remains in client/core source. Dock new-tab and split actions construct empty content. Native browser construction occurs only for browser content, rather than new panes. Worktrunk operations use the configured executable and repository configuration, without a maintainer-specific workflow. The earlier independent backend build and resolved dependency graph verify the core/daemon build gate.

### Applied release checkpoint

- Combined follow-up checks passed: 140 Rust tests, strict Clippy, architecture checks, doctests, and 23 Python tests (17 bootstrap/packaging, two build identity, four first launch). Release build and packaging passed; matching symbols and dependency inventories were generated.
- Durable-session integration passed against release binaries. Updated its stale raw-provider-error assertion to require the safe classified rejection while preserving its checks for retained session identity and no replacement thread.
- Packaged first launch started with no workspace. Native Choose folder opened the macOS picker; selecting an isolated project opened an empty workspace with Conversation, Terminal, and Browser launchers.
- Native typing, pane close, and reopen restored the draft. A protocol read confirmed its payload is stored under the owning Shell window ID. This also caught and fixed an earlier integration mistake: ephemeral chat-view IDs did not match close-retry ownership.
- Applied the release to the existing stable development profile using identity-checked supervisor replacement. Verified new client, daemon, and supervisor processes and the restored native window. The isolated test processes are stopped.
- Added finite pointer-only tab-label feedback and off-thread shortcut saves. Broader motion, full accessibility/native coverage, rich-tool parity, and further Workspace extraction remain open.
- At this checkpoint, concurrent draft conflicts and failed initial reads still lacked recovery UI. The next checkpoint resolves those cases. Old ephemeral chat-view data is not migrated. No whole-plan or public-release completion is claimed.

### Native accessibility and explicit draft recovery

- Combined checks passed with 151 Rust tests, strict Clippy, formatting, architecture checks, doctests, 28 Python tests, and the native AppKit regression fixture. A subsequent packaging test addition passed the expanded 23-test bootstrap suite, including an unsigned archive round trip.
- Draft reads now have explicit loading, ready, and failed states. In an isolated native app, a deliberately unavailable draft service displayed Retry loading draft. Restoring the service and clicking retry recovered the saved text.
- Concurrent draft edits retain both local and saved payloads. Native checks verified Keep this draft saved the local payload at revision 11 after a concurrent revision 10; Load saved draft restored a later revision 20 without changing that saved revision. Unit tests cover compare-and-set races and retained alternatives. Unacknowledged local payloads remain memory-owned until saved; a process crash can still lose them.
- Extracted draft orchestration into draft_controller.rs. Shortcut panels now open before their file read completes; their load task follows panel lifetime, and editing waits for load completion. Shortcut saves already run off the UI thread. Startup keybinding loading remains a separate synchronous seam.
- The platform accessibility bridge appends visible embedded WebKit content to GPUI's AccessKit tree. Native checks exposed page headings and an input, verified focus and keyboard editing, and confirmed that switching to an empty tab removed hidden page controls. The AppKit fixture checks virtual-tree preservation, duplicate registration, hidden ancestors, removal, superclass forwarding, and class restoration. Full VoiceOver, IME, and multi-display coverage remain open.
- Git/Worktrunk command errors now classify unavailable tools, command failures, invalid output, and uncertain outcomes without exposing raw stderr as the error message. Review and Worktrunk operation receipts carry additive recovery fields. Legacy stored receipts remain readable; interrupted operations never replay automatically. The Worktree UI provides an explicit repository refresh; native clicking of that new recovery control remains unverified.
- Packaging now records Rust, provider, and native/resource evidence. Native inventory records archive hashes/member names, cached Zig notices, font evidence, loose resources, and embedded icons. Theme notices, composite Nerd Fonts attribution, shell integration obligations, and exact static linkage remain unresolved distribution-review items.
- Troubleshooting and native dependency decisions are documented. Conditional Tokio adoption was evaluated without adding an unnecessary runtime. Public signing, licensing, authenticated application updates, hosted CI, and another-Mac validation remain open or explicitly deferred.
- The combined release was packaged and applied to the stable development profile. The release-level Git review regression passed, covering failed hooks, stable recovery categories, stale requests, conflicts, restart/crash locks, no replay, and large diffs. Catalog responsiveness during a blocking hook measured at most 0.693 ms in that local run. Temporary browser and draft fixtures were stopped; the test browser tab was closed.

### Tool presentation and background startup

- Added typed tool cards with compact status, expandable input/output, literal output rendering, and exact-copy actions. UTF-8-safe previews limit parsed data to 16 KiB and explicitly disclose the limit. Disclosure and complete-output copying passed rendered tests; the native fixture verified collapsed failure visibility, expanded details, and copying the exact output. Approvals remained usable and denial returned the fixture to Ready.
- Native tab selection was rechecked after an ambiguous earlier observation. Selecting the Codex tab restored the chat composer and its selected state; no tab implementation change was justified.
- Startup installs default shortcuts without filesystem I/O on the UI thread, then applies saved settings from a background read. Application-owned completion and a generation guard prevent late reads from overriding a successful settings save. Three ordering/lifetime regressions passed.
- Native terminal creation uses bounded mutation admission. Connection and initial snapshot share an absolute deadline; successful streams remain connected through idle periods, and closing a pane cancels the socket without stopping the shell. Focused deadline, idle-stream, and cancellation regressions passed.
- Migration tests preserve database bytes on future-schema rejection, roll back a failed migration, and recover after an actual subprocess kill inside an uncommitted migration. The full daemon suite passed; its ignored child-process entry point is exercised by the passing interruption test. Forward migrations still commit individually, so successful earlier steps can remain after a later failure.
- The pre-application combined check passed 161 Rust tests, 29 Python tests, strict Clippy, formatting, architecture checks, doctests, and the AppKit fixture. One subprocess entry point is intentionally excluded from direct Nextest execution and exercised through its parent regression.
- Native shutdown exposed two defects. The close path submitted an untouched empty draft at revision zero; it now skips that payload while preserving retained edits and failed-save fences. Separately, a draft completion could use a closed previous window association and leave the editor Loading. Initialization now starts the read directly, and both draft-load and conflict-resolution completion use the actual owning window. A regression failed before the completion fix and passed afterward, including stale-result rejection and weak editor ownership.
- The final combined check passed 164 Rust tests, 29 Python tests, strict Clippy, formatting, architecture checks, doctests, and the AppKit fixture. The one skipped Rust entry point is invoked by its parent subprocess-interruption test. The rebuilt native fixture loaded its untouched editor and closed successfully; the fixture process exited and its temporary runtime was cleaned up.
- Packaged and applied the release to the stable development profile. The running daemon matches the packaged executable/provider identity, and packaged executable hashes match the release manifest. The replacement client, daemon, and supervisor are present, and both saved windows restored. No source commit, publication, signing, or whole-plan completion is claimed.

### Client organization, bounded flush, and resource notices

- The desktop executable now delegates to the package's private-module library implementation. Conversation selection/history/actions, composer controls, and Workspace layout have separate source files. The client library owns native renderer linkage so interaction tests link correctly without propagating the renderer through the shared platform crate into backends. Legacy standalone layout and request-form composition remain in Workspace rendering; extraction is not declared complete.
- Persistence flush appends its boundary synchronously and uses bounded reserved queue capacity. It no longer creates a waiter thread per flush. Queue saturation reports a retryable failure while preserving accepted saves and failed-save state. Regressions verify full-queue admission, overload, and save ordering across the boundary.
- Shared contextual row actions name each service or worktree, and the review commit input has an accessible name. A rendered test covers enabled/disabled action behavior. Native inspection verified Start/Stop/Output/Edit labels include the fixture service name. This does not establish complete VoiceOver navigation.
- The combined suite passed 167 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the native AppKit fixture. One subprocess entry point remains intentionally skipped directly. In the rebuilt native demo, editing and sending through the extracted composer produced the expected daemon transcript entry, returned to Ready, cleared the editor, and closed cleanly through the new persistence fence.
- Retained 14 pinned upstream notice/evidence files with checksum-verified offline packaging. All 607 cached theme files match the identified upstream revision, whose MIT notice is retained. Available Nerd Fonts glyph notices and the GNU GPLv3 text for the three matching shell scripts are included. Exact glyph attribution, static linkage, and distribution obligations remain open; these supplements do not choose lux-ade's license or authorize publication.
- Applied this build to the stable development profile. Packaged executable hashes, the running daemon identity, and all 14 packaged supplement hashes verified. Both saved native windows restored. No source commit or public release was made.

### Request controls and response recovery

- Extracted provider approvals and question forms into `request_ui.rs`. Question options expose their selected state through native toggle accessibility metadata. Input entities and subscriptions still follow the owning Workspace and request IDs.
- Approval details and manager errors use a shared selectable literal text preview. The preview is bounded to 8 KiB with explicit truncation; copying preserves the complete original payload. Rendered tests cover Unicode, literal fences, and full copying beyond the preview. Native approval testing copied the exact command and verified denial returns the Conversation to Ready.
- Fixed delayed create/open replies overriding a newer workspace selection. A rendered regression failed before the guard and passed afterward. Closed response channels now release the pending action and show an uncertain-result error without replaying the operation. Broader attachment-import teardown behavior and request task ownership remain open.
- Native question testing exposed comma-joined Codex multi-select values. The GUI and Codex adapter now preserve selected labels as array entries; manual text remains a single answer and other adapters retain their current string contract. The protocol regression rejects empty, non-string, over-limit, and disallowed array answers. Native verification confirmed `Read, write` and `Review` arrive as two values, along with a single choice and masked input, before returning to Ready.
- Final combined checks passed 172 Rust tests, 29 Python tests, strict Clippy, formatting, architecture checks, doctests, and the native AppKit fixture. One subprocess entry point is exercised by its parent and skipped directly. The isolated native fixtures closed and cleaned up their runtimes.
- Parallel agents reached the account usage limit during this batch. Their partial edits were inspected and completed locally. The planned broad UI/motion completion audit did not run and is not claimed as done.
- Packaged and applied this release. The running daemon identity and packaged binary hashes verified, and both saved native windows restored. No commits or public release were made.

### Shared presentation audit

- Audited the client palette, button construction, icon usage, and repeated text sizes. Repeated 11/12/13/14 px sizes now use named roles in `ui.rs`; GPUI Kit relative text and spacing utilities retain the shared theme scale. Unique display headings remain local. Contributor rules are recorded in `architecture.md`.
- Expanded the enabled-text contrast regression to include hover and selected surfaces. It failed for the previous muted color on the elevated surface (4.33:1). The adjusted shared color passes at 4.63:1. This check does not claim coverage for translucent overlays, syntax colors, native content, or disabled text.
- Combined checks passed 172 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the native AppKit fixture. One subprocess entry point is exercised by its parent and skipped directly. The release build passed.
- The native component preview showed the shared controls and selected navigation, and selecting Failed changed its accessible tab state and visible status. The preview closed cleanly. Synthetic scrolling did not visibly move the preview, so lower-page error presentation and keyboard focus were not revalidated in this batch. Full VoiceOver and motion timing gates remain open.
- Packaged and applied the build to the stable development profile. Executable hashes match the package manifest, the running daemon identity matches the packaged daemon and providers, and both saved windows restored. No commit or public release was made.

### Attachment import ownership

- Admitted attachment imports now retain their originating editor through draft-save admission. Closing the pane or switching workspaces cannot discard completion. A shared count scoped to the owning window prevents its close fence from overtaking an import after the pane is gone. The editor and count release on completion; imports in other windows remain independent.
- A rendered lifecycle regression closes the pane during a delayed import, checks the window-close guard, then verifies the attachment, text, and incremented revision remain in the original Conversation's retained save. It also verifies the closed editor is released afterward. Reinstating weak ownership makes this regression fail. A separate check covers overlapping imports and isolation between windows.
- Combined checks passed 174 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the native AppKit fixture. The subprocess entry point remains exercised by its parent and skipped directly. This closes the identified import/pane race; it does not establish crash-durable import jobs or complete every client task-lifetime gate.
- The release build and packaging passed. Applied it to the stable development profile, verified packaged executable hashes and the running daemon identity, and confirmed both saved native windows restored. No commit or publication was made.

### Conversation presentation modules

- Moved Conversation view selection, transcript scrolling, requests, queue, composer, and status composition into `conversation_ui.rs`. Standalone navigation and Agent setup now live in `workspace_sidebar.rs`. Workspace rendering retains native-pane layout. Docked chat no longer constructs an unused standalone sidebar. Editor entities and focus handles remain owned by Workspace.
- The first combined check exposed an intermittent terminal idle-stream test failure after successful snapshot restoration. Added diagnostic output for the unexpected event. Twenty isolated runs and the subsequent full suite passed, but the original cause remains unresolved; this is not claimed as a terminal fix.
- Final combined checks passed 174 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point is exercised through its parent and skipped directly. The release build passed.
- Native fixture verification covered rendered Markdown/code, Review request navigation, denial returning to Ready, composer input, and sending the exact prompt through the daemon. The composer cleared after sending. The isolated fixture closed and cleaned up its runtime. This is not a full native accessibility or standalone-layout audit.
- Packaged and applied the release to the stable development profile. Verified executable hashes, the running daemon identity, and restoration of both saved native windows. No commit or public release was made.

### Buffered socket replies after peer closure

- Resolved the intermittent terminal-stream failure from the preceding checkpoint. A 100-run stress loop captured `EINVAL` after restoration. A minimal socket-pair regression then failed consistently while changing the read timeout after peer closure, before reading buffered output. A second regression proved ordinary client RPC replies had the same defect.
- Shared deadline-aware reads now use socket readiness polling in `ade-platform::ipc::read_until`, without changing `SO_RCVTIMEO`. Client RPC and terminal startup readers use this helper. Established terminal reads remain untimed, and owner shutdown still wakes them. The helper requires one reader on a blocking socket with no read timeout.
- Both deterministic regressions pass. The original stress loop passed all 100 runs after the fix. Combined checks passed 176 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the native AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Existing slow-startup, idle-stream, and cancellation checks passed. Temporary diagnostic instrumentation was removed.
- Release build and packaging passed. Applied the fix to the stable development profile and verified executable hashes, running daemon identity, and both restored native windows. No commit or public release was made.

### Prompt acknowledgement ownership

- Fixed an accepted prompt leaving its old draft behind when the editor disappears before the reply. The original rendered regression failed with no draft clear admitted after disposal. Prompt acknowledgements now retain their editor until completion, and persistence does not depend on a native window. Selection and composer updates still require a live view.
- `DraftAction` now provides one shared window-close guard for attachment imports and prompt acknowledgements. Submission synchronizes the text before capturing its revision. A success clears only matching text, attachments, and revision; rejected requests and newer draft revisions remain intact. Other requests retain weak editor ownership, and their pending state releases independently of window mapping.
- The disposal regression covers acceptance, rejection, newer text, owner release, and draft-action guard release. Existing attachment and stale-selection regressions pass. Combined checks passed 177 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the native AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly.
- Release build passed. In the native fixture, the exact prompt appeared once, the Conversation returned to Ready, the composer cleared, and a daemon read confirmed the empty saved draft at revision 2. The isolated fixture closed and cleaned up its runtime. Forced process termination before acknowledgement or save remains outside this ownership guarantee.
- Packaged and applied the release. Executable hashes, running daemon identity, and both restored native windows verified. No commit or public release was made.

### Disposable history reads and explicit recovery

- Older history pages and child transcripts now use the bounded disposable-read pool. Editor-owned guards cancel obsolete client reads on replacement, Latest, child closure, Conversation/workspace selection, and editor disposal. Generation checks reject late results. History decoding runs off the UI thread, and older pages no longer enter the shared latest-message projection.
- History loading disables duplicate requests. Transport, closed-channel, and malformed-page failures retain the existing page and expose Retry loading history. Child transcripts expose retry and reject malformed responses; changing children clears the prior child's page-navigation stack.
- The rendered regression covers preserved messages on each failure, the actual retry control, successful recovery, and rejection of stale completion. Combined checks passed 178 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised through its parent and skipped directly. The release build passed.
- In an isolated native fixture with more than one history page, pausing the daemon produced the visible history error while retaining messages. Resuming it and clicking retry loaded the earlier page; Latest restored the recent messages. A separate save-timeout notice persisted through history recovery, so global error recovery remains open. The fixture closed and cleaned up its runtime. Native child-transcript retry remains unverified.
- Packaged and applied this release to the stable development profile. Executable hashes match the release manifest, the running daemon identity matches the packaged daemon and providers, and both saved native windows restored. No commit or public release was made.

### Save failure notice recovery

- Separated save notices from ordinary action errors. Completed saves and queue-admission failures now publish the visible save error from the same identity-aware failure tracker used by the close fence. Successful unrelated actions cannot hide unsaved changes; recovering one save leaves other failed identities and action errors intact. Tracker and projection updates share a lock order.
- The regression reproduced a stale notice after a successful matching save. It passes with the fix, fails on the same behavioral assertion when clearing is temporarily removed, and passes again after restoration. Additional tests cover unrelated operations, older acknowledgements, separate failed identities, and UI revision changes.
- Combined checks passed 180 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build and packaging passed.
- Native verification paused only the isolated demo daemon, edited a draft, and observed Changes could not be saved with the text retained. After daemon recovery, denying an approval returned the Conversation to Ready without clearing the save notice. A subsequent draft edit saved successfully, cleared that notice, and a daemon read confirmed the exact text at revision 2. The isolated demo closed and cleaned up its runtime. This does not establish automatic retry or a complete global action-error taxonomy.
- Applied the release to the stable development profile. Packaged executable hashes and running daemon identity verified; both saved native windows restored. No commit or publication was made.

### Executable startup and backend source ownership

- All four executables now have small entry points. Daemon and supervisor private module trees separate CLI/diagnostic/environment startup from socket serving and process admission. The terminal adapter has a private implementation module. The supervisor terminal host stays executable-private, preserving native parser linkage without moving it into the runtime control library consumed by the daemon.
- Updated the contributor map to the actual startup, server, PTY, and adapter paths. Conversation controller, draft controller, request forms, composer, viewport, standalone sidebar, and Workspace layout already have feature modules; Workspace retains entity construction, subscription ownership, and focus handles. This completes the source-organization items, not the separate task-lifetime or native-quality gates.
- Combined checks passed 180 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. The subprocess entry point remains exercised by its parent and skipped directly. Release build passed. The fake-provider demo verified code/tool rendering data, approval, and follow-up; the real PTY fixture verified initial snapshot ordering, contiguous output, reconnect behavior, and viewer isolation. The terminal adapter help entry point also ran successfully.
- An independent `cargo check -p ade-daemon --no-default-features` passed. Packaged and applied the release, verified executable hashes and the running daemon identity, and confirmed both saved native windows restored. No commit or public release was made.

### Lost one-shot completion handling

- Audited client spawn, detached-task, and channel-receive sites. Review, Worktrees, Services, and terminal creation silently ignored a closed one-shot response channel. They now convert it into an explicit unknown-outcome error, run their normal completion cleanup, and preserve their existing view ownership and generation checks. They do not replay an admitted operation.
- A rendered Review regression failed because dropping its response sender left the pane pending. It passes with the fix, fails on that same behavioral assertion when old handling is restored temporarily, and passes after restoring the fix. The retained repository projection is checked. Other changed panes share the result conversion; forced lost delivery was not individually rendered for each pane.
- Combined checks passed 181 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build passed. Native verification opened a terminal from the empty pane and displayed the shell prompt, and Services loaded its editable form. The isolated demo closed and cleaned up its runtime.
- The whole task-lifetime gate remains open. Browser navigation currently uses a bounded event queue with ignored overflow, which needs an explicit freshness policy; this audit does not claim that every native resource and task boundary has been verified.
- Packaged and applied the release. Executable hashes and the running daemon identity match the package; both saved native windows restored. No commit or publication was made.

### Docked browser navigation freshness

- Replaced the docked browser's dropping 32-event queue with one pending URL and one bounded wake-up token. Native callbacks replace obsolete addresses without waiting for the UI. The startup `about:blank` filter runs before publication so ignored navigation cannot displace a useful pending address. Receiver closure stops retaining new addresses.
- The burst regression publishes 100 URLs and drains the receiver. The old queue ends at URL 31 instead of 99. The fix passes; temporarily restoring the old queue reproduces that assertion failure, and the restored fix passes in the full suite.
- Combined checks passed 182 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build passed. In the native demo, the browser followed five local HTTP redirects and showed the final `/5` URL together with the final page. The demo and isolated HTTP server were stopped.
- This closes the docked browser overflow issue. The standalone Workspace URL/title queue still needs per-browser coalescing that preserves both fields and their ordering; the broader lifetime/queue gate remains open.
- Packaged and applied the release. Executable hashes and running daemon identity verified, and both saved native windows restored. No commit or public release was made.

### Browser update ownership and URL/title coalescing

- Replaced the retained standalone Workspace's shared dropping queue with one update stream per BrowserView. Each BrowserView owns its native WebView and update task; eviction releases both. URL/title callbacks merge bounded pending state per browser through the same latest-state transport used by docked BrowserPanel. New navigation clears the prior pending title, and ignored URLs or empty titles cannot replace useful state.
- Burst tests cover 100 URL/title pairs for each of two browsers, final field preservation, and navigation/title ordering. A rendered test invokes the production update tasks, verifies independent tab state and the active address, then drops one task and confirms later updates cannot change its tab. The existing docked navigation burst regression continues to pass.
- Source inspection confirmed all current executable Workspace construction paths use the docked shell. The standalone path remains in the code and is tested directly; no native standalone launch is claimed. This resolves the retained queue's identified ownership and freshness gap without claiming completion of every native browser or global task-lifetime gate.
- Combined checks passed 185 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly.
- Release build and packaging passed. Applied the release, verified executable hashes and the running daemon identity, and confirmed both saved native windows restored. No commit or public release was made.

### Recovery controller admission

- Recovery controls now have one pending request slot and use nonblocking admission. The existing busy gate suppresses duplicate requests; the queue bound also covers a background status poll completing around a queued action. A full slot preserves the waiting action and reports rejection. A stopped worker releases busy state, clears the unaccepted action notice, and tells the user to reopen lux-ade.
- The stopped-worker regression reproduced indefinite busy state before the fix. It passes with the fix, fails on the same assertion when failure handling is temporarily removed, and passes again after restoration. Additional checks verify repeated and excess requests do not replace or accumulate behind the accepted action.
- Combined checks passed 187 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. The release build passed. The broader queue audit remains open; native menu-command overflow still needs an explicit user-visible policy.
- Packaged and applied the release. Executable hashes and running daemon identity verified; both saved workspace windows restored. In the native recovery window, Check builds completed, both build identities matched, and the controls returned to idle. The recovery window was closed afterward. Forced stopped-worker behavior remains covered by the regression, not by terminating the live worker. No commit or publication was made.

### Native menu-command overflow

- Native menu and shortcut callbacks retain at most 32 accepted commands in FIFO order. Additional commands set one overflow notice instead of disappearing silently. A bounded wake signal avoids accumulating notifications. Closing the receiver stops publication.
- The callback regression sends 100 commands and checks the accepted sequence and one overflow event. It reproduced the missing notice before the fix, passed with the fix, failed on the same assertion with overflow publication temporarily removed, and passed after restoration. A rendered Dismiss test verifies that dismissing the notice preserves action and save errors.
- Combined checks passed 189 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build and packaging passed.
- Applied the release, verified packaged executable hashes and running daemon identity, and confirmed both saved windows restored. Native Command-T added exactly one empty tab with Conversation, Terminal, and Browser choices. The attempted shortcut close did not remove the temporary tab; the subsequent Review verification closed it with the native Close tab control and verified the tab count. Overflow itself was exercised through the native callback regression, not by flooding the live app. The broader task-lifetime and queue audit remains open. No commit or publication was made.

### Review response-task ownership

- Changes now owns its response task instead of detaching it. Closing the view releases its completion receiver, while admitted Git mutations continue in the existing bounded pool. Disposable read cancellation and polling ownership remain unchanged.
- A rendered regression closes the actual test window, releases the entity, and checks that the reply producer observes receiver closure. The test passes with view ownership and fails on the same retained-waiter assertion after temporarily restoring detached completion. The fixed source was restored before validation.
- The first combined run exposed a history test scheduler violation from a real request worker. The test now explicitly permits external worker wakeups and exercises them with an actual thread. Production history decoding remains unchanged. The final combined run passed 190 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. The release build passed.
- This verifies Review completion ownership, not the full application task-lifetime gate. Services and Worktrees still require the same completion-ownership audit.
- Packaged and applied the release; executable hashes and running daemon identity matched. Both saved workspace windows restored. The native Changes window loaded the repository file list and closed successfully; only the two workspace windows remained. Pending-response disposal is verified by the rendered regression, not inferred from this native smoke check. No commit or publication was made.

### Services and Worktrees completion ownership

- Services now owns its response task. Superseding a refresh releases its waiter while the existing generation guard protects the current result. Worktrees owns separate lifecycle and workspace-open response tasks. Closing either manager releases response receivers; admitted mutations and catalog reconciliation continue in their existing bounded workers.
- Worktrees permits one pending workspace open per manager. Open controls are disabled during that request, duplicate calls preserve its reply, and failure or missing completion releases the pending flag with an error. Closing the manager cannot create a late native workspace window.
- Rendered close-window regressions reproduced retained response waiters in both managers. Both passed after the ownership change, failed on the same assertions when tasks were temporarily detached again, and passed after restoration. A further test verifies duplicate Open admission and busy-state recovery after a closed reply channel.
- Combined checks passed 193 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build passed. The full task-lifetime gate remains open; these tests cover manager completion ownership rather than every client task.
- Packaged and applied the release. Packaged executable hashes and running daemon identity verified; both saved workspace windows restored. Native Worktrees and Services windows opened with their controls and closed successfully, leaving the two workspace windows. Pending-response disposal and duplicate-open behavior remain covered by the rendered regressions, not by this smoke check. No commit or publication was made.

### Conversation transcript completion ownership

- Workspace now owns history and child-transcript completion tasks. Resetting history, closing a child reader, replacing a read, or destroying the editor releases the corresponding completion task. History completion owns its background decode task; a decode already executing can finish, while pending waits are cancelled. Existing disposable network guards and stale-generation checks remain in place.
- The rendered regression covers reset and window/editor destruction for both response channels. It reproduced a retained history waiter before the fix, passed with ownership, failed on the same assertion when completion tasks were detached again, and passed after restoration. Existing history failure/retry and stale-result coverage still passes; its generation test keeps the completion alive deliberately so cancellation does not mask that check.
- Combined checks passed 194 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build passed. This verifies transcript completion ownership, not every remaining client task; draft loading and resolution completion ownership still need review.
- Packaged and applied the release. Verified packaged executable hashes, running daemon identity, and restoration of both native workspace windows. Transcript cancellation is verified by rendered regressions; native startup is only a launch smoke check. No commit or publication was made.

### Draft completion ownership

- Workspace now owns separate draft-load and draft-resolution completion tasks. A new load releases the previous completion before an empty-selection or cached-draft return. Editor destruction releases both response receivers. Selection changes preserve an admitted resolution's completion so it can release pending state; existing generation and Conversation checks still reject stale text.
- Persistence worker ownership is unchanged. Dropping these response tasks does not cancel accepted draft saves, resolutions, or ordered reads.
- Extended the rendered owning-window regression. It first reproduced a retained draft-load waiter after editor disposal, then passed with ownership. Added cached-restoration and empty-selection cancellation checks; temporarily restoring detached tasks reproduced retained obsolete-load behavior. Restored the fix and passed all checks. The regression also covers resolution waiter disposal, pending release after selection changes, stale text rejection, and current resolution application.
- Combined checks passed 194 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build passed. This completes the draft completion audit, not the entire task-lifetime gate; remaining detached UI work still needs classification.
- Packaged and applied the release. Verified packaged executable hashes, running daemon identity, and restoration of both native workspace windows. Completion ownership is verified by rendered regressions; native restoration is a startup smoke check. No commit or publication was made.

### Picker ownership and detached-work inventory

- Attachment and Startup picker completion tasks now belong to their views. Closing a view releases its pending picker response waiter. Selected attachments still use the retained admitted-import path, and accepted workspace-open commands remain in the command pool.
- Both rendered close-window tests failed with detached waiters, passed with view ownership, failed on the same assertions when detachment was temporarily restored, and passed after restoration. These tests cover response waiters, not AppKit panel dismissal.
- Added a source-based detached-work inventory to task-lifetimes.md. It distinguishes accepted operations, app/window subscriptions, development-only tasks, and native surface detach methods from unresolved async ownership. Remaining gaps include non-prompt response waiters, retained standalone terminal completion, repeated reload admission, and final-window shutdown admission.
- Combined checks passed 196 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build passed. The full lifetime gate remains open.
- Packaged and applied the release. Verified packaged executable hashes, running daemon identity, and restoration of both native workspace windows. The native attachment picker opened, cancelled, reopened successfully, and cancelled again, leaving only the two workspace windows. This verifies the normal picker cancellation/re-entry path; close-view waiter disposal remains covered by rendered tests. No files were selected or imported. No commit or publication was made.

### Ordinary action response ownership

- Workspace now owns its ordinary conversation-action response task and the response task for retained standalone terminal creation. Editor disposal releases those waiters. The existing pending gate bounds admission; accepted commands remain owned by the command pool, and terminal processes remain owned by the supervisor.
- Prompt acknowledgement retains its existing detached task, strong editor reference, and per-window draft-action guard through draft-save admission. It deliberately does not share the disposable action task.
- A rendered regression covers ordinary-action and standalone-terminal waiter disposal. It failed before ownership, passed after the change, failed on the same ordinary-action assertion with detached handling temporarily restored, and passed after restoration. Existing prompt-after-disposal, newer-draft, selection, and lost-response tests also pass.
- Combined checks passed 197 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build passed. Updated the detached-work inventory; repeated reload and final-window shutdown admission remain open.
- Packaged and applied the release. Verified packaged executable hashes, running daemon identity, and restoration of both native workspace windows. Ordinary/terminal waiter disposal and prompt retention are covered by rendered tests; native restoration is a startup smoke check. No commit or publication was made.

### Reload and final-window shutdown admission

- Runtime Reload now acquires one process-wide permit before admitting its persistence fence. A second click cannot queue another reload while that fence or replacement is pending, including from another Runtime window. The permit clears on failure and the shared UI updates its disabled state. Successful replacement continues to use in-place `exec`.
- Final-window shutdown now has one App-scoped flush worker. Each later transition to zero windows advances a generation; the worker waits for a new fence before deciding to quit. It quits only after the latest fence succeeds with no windows open. A failed latest fence still opens recovery.
- Admission regressions reproduced duplicate reload acceptance and duplicate final-window waiters before the fixes. Both passed with the fixes, failed on their original behavioral assertions when the guards were temporarily removed, and passed after restoration. Existing persistence and close tests continue to pass.
- Combined checks passed 199 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. One subprocess entry point remains exercised by its parent and skipped directly. Release build and packaging passed.
- The packaged two-window UI smoke path exited successfully after closing its parent, child overlay, and sibling. Applied the release; packaged hashes and running daemon identity matched, and both saved windows restored. A native Runtime Reload then replaced the client in place and restored both windows again. Rapid native close/reopen and duplicate-click timing were not forced in the live app; the admission regressions cover those state transitions. No commit or publication was made.

### Dark interface palette refinement

- The running native screenshot showed a bright gray sidebar and composer against a nearly black chat canvas. Adjusted the shared semantic palette to a quieter charcoal range with warmer text, keeping sidebar, tabs, hover, selection, and composer colors linked through existing tokens.
- The existing enabled-text contrast test passed for the new text, muted, danger, and success colors across every shared surface. Combined checks passed 199 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. Release build and packaging passed.
- Applied the release, verified packaged hashes and running daemon identity, and restored two native windows. A fresh native screenshot confirmed the sidebar and composer now sit closer to the chat canvas in value while selected rows remain visible. This is a palette improvement, not completion of the full visual foundation or chat parity gates. The current disconnected chat and sparse sidebar still need interaction and visual work. No commit or publication was made.

### Pending request visibility

- A populated native fixture showed a pending approval below the initial transcript viewport. The Review request shortcut could reveal it, but its Allow and Deny controls were not visible on arrival. Requests now have a bounded scroll area above the composer. The transcript can scroll separately, and a new request resets its form to the top.
- A fresh packaged native fixture displayed the approval title, command, and both decisions immediately, without using Review request. The full local check passed 199 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture; one subprocess entry point remains exercised by its parent and skipped directly.
- Release build and packaging passed. Applied the release to the stable development profile, verified packaged executable hashes, and restored both saved windows. At this checkpoint, long multi-question forms and small-window geometry still needed native coverage. No commit or publication was made.

### Long request form in a narrow window

- A 1000 × 750 native fixture exposed all three Codex questions but clipped the final field and Submit answers behind the composer until the request area scrolled. Added a visible scrollbar and a header Actions control that jumps to the end of the bounded request area; Review request returns to the start. The Actions control keeps an icon in compact pane headers.
- In the packaged fixture, the request area had 215 px of measured overflow. The Actions control revealed the final fields and Submit answers above the composer. I selected the mode and multi-select option, entered the masked fixture field, submitted, and confirmed the Conversation returned to Ready with zero pending requests. The native computer-use scroll command did not move this window reliably, so the direct header controls supplied the verified path; ordinary pointer-wheel scrolling still needs a separate native check.
- Removed temporary scroll diagnostics. The final check passed 199 Rust tests, 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture; one subprocess entry point remains exercised by its parent and skipped directly. Release build and packaging passed. Applied the final bundle to the stable development profile; all four packaged hashes match its manifest, and both saved windows restored. Smaller geometry and screen-reader behavior remain open. No commit or publication was made.
- A follow-up isolated fixture saved the window at lux-ade's enforced 1000 × 700 minimum. Native inspection confirmed the form's start and, after Actions, its last fields and Submit answers remain above the composer. This verifies the current minimum geometry; resizing below it would require changing the window policy and a separate layout audit. The fixture now accepts `--min-window` to repeat the check.

### Chat text selection and copying

- A rendered GPUI test drags across the actual chat Markdown view and confirms that Cmd-C copies its selected text exactly. The view already allowed selection, but GPUI Kit's TextView Copy handler trimmed the result, dropping selected whitespace. Its root fallback applied the same trim. Both handlers now preserve the selected payload while allowing a nonempty whitespace-only selection to propagate.
- The regression failed before the TextView fix, passed with it, failed again when the original trim was temporarily restored, and passed after restoration. The vendor patch was checked against the pinned archive and reproduced all 3,527 generated GPUI Kit files exactly.
- The full check passed 200 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit accessibility fixture; one subprocess test entry point is exercised by its parent and skipped directly. Release build and packaging passed. The new client launched with both saved native workspace windows; all four packaged executable hashes match the manifest. At that checkpoint, native drag-and-copy remained unverified; the rendered test covered the actual Markdown view and Copy shortcut. No commit or publication was made.
- A later isolated long-transcript fixture resolved the native check. After bringing its window forward, a macOS mouse drag visibly selected rendered Agent text, and Cmd-C copied `vious message 359 A measured hist\n` from that selection. Orca's synthetic drag had produced no selection, so it was not evidence of an lux-ade failure. This verifies one native drag-and-copy path through a virtualized transcript; selection across messages, code blocks, and all provider renderings remains part of the wider chat parity gate.
- That native copy also exposed a defect in the earlier selection fix: a drag ending within one visible line copied a trailing structural newline. The rendered regression now asserts that such a drag has no terminal newline. GPUI Kit's document extractor removes only its final added block separator; the Copy handlers still preserve whitespace selected from actual content. The test failed before the extractor fix, passed with it, failed again when that fix was temporarily removed, and passed after restoration. The pinned patch and metadata hash reproduce all 3,527 vendor files.
- The updated packaged native fixture copied `torical response. A measured historic` from a within-line drag with no extra newline. The final check passed 201 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. Release build and packaging passed; all four executable hashes match the manifest. Applied the client to the stable development profile and confirmed both saved windows restored. This is one within-line selection path, not a complete cross-block or code-block selection audit. No commit or publication was made.
- GPUI Kit's standalone `gpui-base` text test target passed 216 text tests against the patched source, including its existing text-view selection and virtualized-copy cases. This broadens the check beyond lux-ade's own rendered test; exact content selection across block boundaries still needs an explicit behavior check.
- A new rendered test selects a whitespace-only Markdown TextView and checks Cmd-C copies the selected bytes. It failed before the change, passed after GPUI Kit stopped filtering nonempty whitespace-only selections, failed again when the old filter was temporarily restored, and passed after restoration. The root and TextView Copy guards now reject only truly empty text. The pinned patch hash reproduces all 3,527 GPUI Kit source files, with 13 modified files recorded in the vendor ledger.
- The combined check passed 202 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. GPUI Kit's standalone text target passed 216 tests. Release build and packaging passed; all four executable hashes match the manifest. The updated client launched against the stable development profile, and macOS reported both saved windows after activation. Exact selection across block boundaries, code blocks, and provider renderings remains open. No commit or publication was made.

### Provider failure presentation

- A saved failed Conversation exposed raw provider JSON in the main attention card. The card now shows a short recovery message by default, with Show diagnostics in its header. Expanding it reveals the bounded literal preview and the existing complete-payload Copy action. Switching Conversations resets the disclosure.
- A rendered test checks that the raw diagnostic controls are absent until disclosure, then copies the exact provider payload. It failed before the change, passed with it, failed again when the old card was temporarily restored, and passed after restoration. The final combined check passed 201 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. Release build and packaging passed.
- Applied the new client to the stable development profile. Both saved native windows restored; all four packaged executable hashes match the manifest. Native inspection of the same failed Conversation showed the recovery message with raw JSON hidden, then exposed Hide diagnostics and Copy after Show diagnostics; hiding removed those controls again. This closes the provider-card presentation gap only. Other error surfaces and the full error-recovery gate still need audit. No commit or publication was made.
- The shared diagnostic card now shows a contextual recovery message first and keeps the raw payload behind Show diagnostics. Conversation action/save failures, the startup view, and the runtime/recovery view use it; each view owns disclosure state and clears it when its error disappears. A different error starts collapsed. The provider card now uses the same presentation helper. Rendered tests cover the generic card and actual startup connection view, including exact diagnostic copy. The new test failed to compile before the component existed and passed after implementation; the first startup interaction test exposed a missing test selector, which was added before it passed.
- The final combined check passed 205 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. Release build and packaging passed. The updated client launched against the stable development profile with both saved windows; all four packaged executable hashes match the manifest, and neither daemon nor supervisor needs an update. History, worktree, review, service, and inline errors still show raw detail and need the same contextual audit before the full error-recovery gate can pass. No commit or publication was made.
- History and child-transcript reads, worktree operations, review actions, and service operations now show contextual recovery guidance with raw diagnostics behind disclosure. Their views own the disclosure state. A new error starts collapsed, and clearing an error resets it. Local validation remains immediate: the review view shows the missing commit message, and the service view shows form and workspace-switch guidance as plain text. Provider disclosure now follows the same error-bound state rule. The remaining production uses of `error_card` are those deliberate validation surfaces; the component studio and test fixture retain diagnostic examples.
- The final check passed 205 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. Release build and packaging passed. The updated client launched with both saved windows, and all four packaged executable hashes match the manifest. Rendered component and startup tests cover disclosure and exact copy; native interaction with each new error surface has not yet been exercised. Inline command, draft, and terminal errors still need a contextual review before the full error-recovery gate can pass. No commit or publication was made.
- Command shortcut validation now appears as immediate guidance, while shortcut file errors use a contextual card with hidden diagnostics. Draft-loading failures retain their retry control and editor text; a rendered test confirms the error starts collapsed, reveals exact copy, then retries successfully. The workspace banner no longer repeats raw action errors and links to the recovery view. Window-close save failures keep Retry save and close and Keep working visible while raw details sit behind disclosure.
- Both terminal presentations now distinguish recovery from diagnostics: the legacy terminal stream retries automatically and displays a short reconnecting status, while an independent terminal pane keeps Retry connection visible. The worktree operation status also hides raw job errors next to its existing recovery guidance. Independent browser panes now offer Retry opening browser after WebKit child-view creation fails; ordinary navigation errors retain Go and Reload with diagnostics available on request. These native error and retry paths still need deliberate interaction checks on a running Mac.
- The final check passed 205 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the AppKit fixture. Release build and packaging passed. The new client launched with both saved windows; all four packaged executable hashes match the manifest and the daemon/supervisor require no update. This advances presentation and recovery but does not close the full error-recovery gate, which still needs native failure-path verification and correlation across processes. No commit or publication was made.

### Process-level diagnostic correlation

- Client RPCs now carry a generated diagnostic ID without changing their domain request ID. Client and daemon record bounded start, success, and failure events with a fixed operation family and elapsed time. For a Conversation request, the daemon records a diagnostic ID to Agent run ID join; the supervisor records the run ID to provider PID join. Existing provider process events complete the path. IDs are validated before logging or export, and the export whitelist excludes prompts, paths, titles, provider payloads, and error text. Failed client RPCs expose their diagnostic ID in the diagnostic detail so an exported report can be searched.
- The isolated real-process test sent a mock Codex prompt with a diagnostic ID and verified request → run → provider PID events in the daemon and supervisor logs. Export retained the join keys and omitted the prompt and temporary path. The full check passed 210 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the native AppKit fixture. Release build and packaging passed. The new package replaced the client, daemon, and supervisor in the stable development profile; both saved windows restored, no update remains, and all four packaged executable hashes match the manifest. The supervisor replacement ended its former shell. Native failure-path checks and broader error-recovery verification remain open. No commit or publication was made.
- The correlation test also passed against a debug workspace build with the native-terminal feature. CI now runs it after the macOS build and regular check suite.

### View and process lifetimes

- Audited production channel creation and queue storage. Client request queues bound job count and bytes and report admission failures; browser navigation coalesces to one pending update; command shortcuts report overflow; daemon subscriptions evict slow readers; supervisor Agent replay and terminal replies have byte or item limits with explicit failure or drop counters. The unbounded `mpsc::channel` calls in the client are confined to tests.
- The terminal ownership test had an obsolete assumption that each newly opened native window attaches terminal viewers. It now checks the actual empty-pane contract: one, four, and ten native windows leave the terminal detached, and closing them preserves the same shell PID. Raw viewer disconnects still transfer resize ownership, and a saturated reply queue still drains with a counted drop. The isolated Agent test now closes a session subscriber and verifies the supervisor still owns the same run and provider PID. Both scripts passed against current debug or release binaries. These checks support the bounded-queue and supervisor-process items; the full pane/window lifetime gate remains open pending a wider cancellation and native-resource audit.
- The isolated tab lifecycle test also passed: three independent shells survive tab close, reorder, reopen, and daemon handoff with the same PIDs. Eighty stop/retire cycles reclaimed capacity without resurrecting retired terminals. Native pane disposal and task cancellation still need direct checks before the full lifetime gate can pass.
- A new isolated native view-lifetime script runs the existing UI smoke path against a temporary daemon. It confirmed that closing a parent window disposes its attached AppKit child overlay while a sibling window remains, then the final window closes the client cleanly. This does not yet prove WebView disposal or every detached task path, so the subscription/native-resource item and full lifetime gate remain open.
- The client close gate, final-window flush, and in-app Reload client action now bound save acknowledgement waits to 30 seconds. The close gate also bounds its `window.close` acknowledgement. A timeout keeps the UI open and reports an uncertain outcome; dropping the waiter does not cancel work already admitted to a worker. A unit regression checks that an available reply wins over an expiring deadline and that timeout releases the waiter. The full check passed 211 Rust tests and 29 Python tests, formatting, strict Clippy, architecture checks, doctests, and the native accessibility fixture. The isolated release UI smoke path passed after the change. Release build and packaging passed; the updated client launched with both saved windows, all four bundle hashes match the manifest, and the daemon/supervisor need no update. Broader process shutdown order and native failure-path validation remain open. No commit or publication was made.
