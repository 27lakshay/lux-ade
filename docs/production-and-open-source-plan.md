# lux-ade production and open-source plan

Saved: 2026-09-25

Status: Implementation in progress. This document preserves the full agreed scope. See [Implementation task list](implementation-task-list.md) for verified progress and remaining work. Publication is not authorized.

The plan is to turn lux-ade into a maintainable, open-source desktop app with the completeness of a polished Electron application, while keeping Rust, GPUI, and the separate client/daemon/runtime architecture.

This covers code organization, packages, error handling, state management, macOS behavior, UI quality, animations, testing, contributor experience, and public distribution. At the time this plan was written, no restructuring or dependency changes described here had started.

We have not yet demonstrated full parity in rich chat rendering, accessibility, native interaction edge cases, or distribution. The work below includes explicit checks for those areas.

## 1. Establish the product and architecture rules

Keep these decisions consistent throughout the work:

- GPUI renders the desktop interface.
- The daemon owns durable application state and application operations.
- The runtime supervisor owns long-lived terminal and provider processes.
- Provider adapters may remain in JS/TS where official SDKs make that the practical choice.
- Chat uses a robust GUI for every provider. No GUI/TUI switching or session handoff. Users can run provider CLIs independently in a terminal.
- New tabs and splits start empty, offering Conversation, Terminal, and Browser.
- Browser resources start only through explicit user action.
- Multiple windows are a first-class capability.
- Customization is general-purpose, without embedding the maintainer’s personal Worktrunk configuration or workflow.

Use the cloned apps as implementation references, then adapt their strongest ideas to lux-ade’s architecture. Record provenance when actual code is reused.

**Completion check:** these rules guide module ownership, tests, and UI behavior without contradictory implementations.

## 2. Make the project independently buildable

Before reorganizing large amounts of code, remove dependence on this particular development directory.

Work includes:

- Establish a standalone repository layout.
- Pin the Rust toolchain and document supported macOS versions and architectures.
- Replace external `../../work/...` assumptions with reproducible dependency setup.
- Pin native dependencies and patched GPUI revisions.
- Keep required patches reviewable, with their purpose and upstream status recorded.
- Separate generated binaries, caches, logs, screenshots, and runtime data from source.
- Resolve packaged assets from the installed application rather than development paths.
- Provide consistent bootstrap, development, test, and release commands.
- Use pnpm for JS/TS provider packages.
- Supply a fake provider so contributors can exercise the interface without credentials or paid requests.

**Completion check:** a clean checkout on another supported Mac can build, test, and launch lux-ade using documented commands.

## 3. Organize the Rust code around real responsibilities

Use a Cargo workspace with a small number of crates:

```text
ade/
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── crates/
│   ├── ade-core/        Models, protocol, errors, state transitions
│   ├── ade-client/      GPUI interface and daemon connection
│   ├── ade-daemon/      Sessions, persistence, providers, worktrees, services
│   ├── ade-runtime/     Process supervision, PTYs, terminal state
│   └── ade-platform/    Native integration and resource ownership
├── providers/          JS/TS provider adapters
├── assets/
├── scripts/
├── tests/
└── docs/
```

Inside the client, organize by feature: shell, chat, panes, sidebar, terminal, browser, settings, and shared UI components.

Keep executable entry points small. Move behavior into modules with narrow public interfaces. Avoid a crate for every helper, a generic plugin system before it is needed, or large collections of unrelated utilities.

Refactor incrementally, preserving behavior between steps.

**Completion check:** core logic can compile and test without GPUI or Ghostty, and the daemon can build without desktop UI dependencies.

## 4. Define state ownership and background-task lifetimes

Use GPUI entities for interface state, with ordinary Rust structs and enums for application models.

| State | Owner |
|---|---|
| Conversations, messages, approvals, workspaces | Daemon, persisted in SQLite |
| Provider processes and terminal shells | Runtime supervisor |
| Current client view of daemon state | Shared client model |
| Tabs, splits, focus, scroll position | Window and pane entities |
| Drafts, attachment selection, open menus | Relevant chat or input entity |

Extract complex transitions—connection recovery, chat lifecycle, tab operations—into testable functions that accept events and produce state changes plus requested effects.

For background work:

- Give each task an owner and a cancellation policy.
- Use bounded queues with explicit overflow behavior.
- Keep database access, subprocess operations, and expensive parsing off the UI thread.
- Reject stale results using request identifiers or generations.
- Release subscriptions and native resources when their owners close.
- Preserve supervisor-owned processes when their views close.
- Define shutdown order and deadlines.

Keep GPUI’s executor for UI tasks. Introduce Tokio into daemon I/O incrementally where it simplifies ownership, cancellation, and shutdown.

**Completion check:** closing a pane or window leaves no orphaned UI tasks, and late responses cannot update the wrong conversation.

## 5. Make errors understandable and recovery deliberate

Adopt a consistent error model:

- `thiserror` for errors that callers must classify.
- `anyhow` for contextual propagation at application entry points and orchestration code.
- Typed protocol errors with stable codes.
- Separate user-facing messages from diagnostic details.

Audit production uses of `.unwrap()`, discarded results, silent defaults, and raw string errors. Preserve intentional cases, such as an update arriving after a view has closed.

Define behavior for authentication failures, rate limits, provider exits, broken connections, failed saves, invalid data, and unknown request outcomes. Retry only when the operation and its outcome make retry safe.

Add structured diagnostics with `tracing`, `tracing-subscriber`, and `tracing-appender`:

- Correlate client, daemon, runtime, and provider activity.
- Rotate and bound local logs.
- Sanitize diagnostic fields.
- Replace discarded provider stderr with a bounded, privacy-aware diagnostic policy.
- Preserve release symbols separately for useful crash investigation.
- Make diagnostic export explicit and inspectable.

**Completion check:** important failures produce an actionable UI state and enough safe diagnostic information to investigate them.

## 6. Standardize the dependency set

The initial direction is:

| Purpose | Package or tool | Decision |
|---|---|---|
| Interface and entities | GPUI + GPUI Kit | Keep |
| Serialization | `serde`, `serde_json` | Keep; strengthen typed messages |
| Persistence | `rusqlite` | Keep; formalize migrations and ownership |
| Error handling | `thiserror`, `anyhow` | Add typed errors; retain context propagation |
| Diagnostics | `tracing`, `tracing-subscriber`, `tracing-appender` | Add |
| Async daemon work | `tokio`, `tokio-util` | Introduce selectively |
| Native integration | `objc2` and required framework bindings | Evaluate at each native seam |
| Terminal process support | Existing Ghostty integration and `portable-pty` | Keep; isolate and document |
| Generated-case testing | `proptest` | Add for state and protocol invariants |
| Snapshot testing | `insta` | Use selectively for stable output |
| Development checks | rustfmt, Clippy, cargo-nextest, cargo-deny | Establish in CI |

Before integrating a dependency, check its current official documentation, compatibility with our pinned stack, and any agent guidance it provides. Avoid overlapping libraries that solve the same problem.

## 7. Build a coherent frontend foundation

Create reusable components for buttons, inputs, menus, dialogs, tooltips, tabs, status indicators, empty states, and errors.

Centralize:

- Typography and text hierarchy.
- Colors and contrast.
- Spacing and sizing.
- Borders and corner radii.
- Icons.
- Focus, hover, pressed, disabled, loading, and error states.
- Animation durations and easing.

Build a development-only component preview window, equivalent in purpose to Storybook. It should expose realistic states without requiring a live provider.

Use Codex as the visual reference for chat and sidebar, and Orca for workspace interaction. Keep lux-ade’s components consistent across every feature.

**Completion check:** a visual adjustment happens in shared components or tokens, and new screens reuse established behavior.

## 8. Bring chat and workspace interactions to parity

Complete one representative workflow:

> Open a project → start a conversation → stream Markdown and tool results → handle an approval → open a terminal in a split → switch tabs and windows → disconnect and recover → close and reopen lux-ade.

Chat work includes:

- Reliable text selection and copying.
- Markdown, code blocks, highlighting, and copy actions.
- Attachments and composer behavior.
- Tool activity, results, approvals, and questions.
- Queueing, cancellation, retry, and recovery.
- Long-history performance and predictable scrolling.
- Clear loading, empty, disconnected, and failed states.

Workspace work includes:

- Tabs, splits, drag-and-drop, resizing, zoom, and restoration.
- Predictable keyboard focus and shortcuts.
- Independent windows and drafts.
- Lazy browser lifecycle.
- Correct behavior when native terminal or browser views overlap menus and dialogs.

**Completion check:** the complete workflow works with the fake provider and representative real providers, including failure paths.

## 9. Add restrained animations and transitions

Introduce motion after the affected component’s behavior is stable.

Initial targets:

- Hover and press feedback.
- Menus and popovers.
- Sidebar visibility.
- Tab insertion, removal, and settling.
- Empty-pane-to-content transitions.
- Restrained progress indicators.

Use approximate starting ranges of 80–120 ms for micro-feedback, 140–180 ms for menus, and 180–240 ms for larger layout transitions. Tune through actual use.

Keep typing and conversation switching immediate. Dragging and resizing must track the pointer directly. Respect Reduce Motion and handle interrupted animations cleanly.

Native browser and terminal transitions require separate verification for focus, clipping, sizing, and flashing.

**Completion check:** motion improves orientation without delaying input or regressing frame timing.

## 10. Establish macOS quality and automated verification

Test desktop behavior explicitly:

- Keyboard navigation, shortcuts, text selection, and input methods.
- Clipboard, file drops, context menus, and notifications.
- Accessibility labels, screen-reader behavior, and visible focus.
- Display scaling, window resizing, multiple displays, and multiple windows.
- Sleep/wake and connection recovery.
- Main-thread requirements and native resource cleanup.

Build several layers of verification:

| Layer | What it proves |
|---|---|
| Unit and state-transition tests | Rules and error classification |
| Property tests | Invariants across unusual event sequences |
| Integration tests | Persistence, providers, process lifecycle, reconnects |
| GPUI interaction tests | Component and pane behavior |
| Native application checks | AppKit, terminal, browser, focus, accessibility |
| Performance checks | Startup, responsiveness, memory, long histories |

Include duplicate events, stale responses, failed writes, provider crashes, shutdown during work, and repeated window opening/closing. Preserve current performance checks while improving what they measure.

**Completion check:** CI catches meaningful regressions, and native checks cover behavior that unit tests cannot prove.

## 11. Prepare the open-source project and releases

Before public distribution:

- Choose the project license after reviewing dependency and reused-code obligations.
- Include third-party notices and provenance.
- Document setup, architecture, contribution flow, testing, and troubleshooting.
- Add a short Rust guide for JS/TS contributors.
- Explain where to change a component, provider, command, protocol message, or migration.
- Establish versioning and compatibility rules for client, daemon, runtime, and stored data.
- Produce packaged release artifacts with signing and notarization.
- Choose and test an update mechanism, including interrupted updates and recovery.
- Verify releases on a clean supported machine.

Signing identity, project license, and public repository ownership remain decisions to resolve before release; they do not block the earlier engineering work.

## What we carry forward from the clones

| Reference | Pattern to adopt |
|---|---|
| Ghostex | Chat state separated from rendering through events and effects |
| Herdr | Control traffic protected from heavy terminal rendering traffic |
| Paseo | Explicit connection lifecycle and cleanup of pending requests |
| T3Code | Safe diagnostics and scoped client state |
| OpenCode v2 | Enforced separation between UI and server implementation |
| Orca | Explicit tab, group, focus, and workspace behavior |
| Oh My Pi | Provider-aware error classification and retry policy |

## Execution order

First make the build portable and establish diagnostics, then separate modules and clarify state ownership. Build the shared UI foundation next, finish the representative workflow, and validate desktop behavior. Add motion alongside stable components, then complete public-release tooling.

Each stage should leave a working, tested app. The measure of success is that another developer can understand and change lux-ade, and a user can complete everyday work without encountering prototype behavior.
