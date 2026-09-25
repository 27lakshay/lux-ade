# Architecture and contribution map

This describes the current workspace. The implementation task list records work still pending.

## Process ownership

The desktop client renders a disposable view of daemon state. The daemon writes
SQLite and coordinates application operations. The runtime supervisor owns
provider processes and terminal shells so closing a view does not stop work.

```text
ade-client ── local protocol ── ade-daemon ── supervisor protocol ── ade-runtime
    │                              │                                  │
 GPUI windows                   SQLite                         providers and PTYs
```

Source dependencies differ from process connections. `ade-client` imports shared
contracts from `ade-core`, not daemon implementation. `ade-daemon` uses the
runtime library's control client. The runtime library has no database or GUI
dependency. `ade-platform` provides diagnostics and resource lookup to all three. Its optional
`native-ui` feature owns the AppKit/Ghostty bridge and is enabled only by the client.

## Where changes belong

| Change | Start here |
|---|---|
| Shared serialized data | `crates/ade-core/src/model.rs` |
| Provider capabilities and configuration | `crates/ade-core/src/provider.rs` |
| Protocol size limits and decoding | `crates/ade-core/src/protocol.rs` |
| Shared controls, tokens, and preview | `crates/ade-client/src/ui.rs` |
| Startup, restoration, window lifecycle | `crates/ade-client/src/bootstrap.rs` |
| Window shell and sidebar | `crates/ade-client/src/shell_ui.rs` |
| Pane/tab operations | `crates/ade-client/src/dock_ui.rs` |
| Chat rows, queue, attachments | `crates/ade-client/src/chat_ui.rs` |
| Structured tool disclosure and literal output previews | `crates/ade-client/src/tool_ui.rs` |
| Draft save, restore, conflict resolution | `crates/ade-client/src/draft_controller.rs` |
| Draft load state and retry controls | `crates/ade-client/src/draft_ui.rs` |
| Conversation selection, history, and daemon actions | `crates/ade-client/src/conversation_controller.rs` |
| Conversation viewport, request placement, queue, composer, and status composition | `crates/ade-client/src/conversation_ui.rs` |
| Composer and draft recovery controls | `crates/ade-client/src/composer_ui.rs` |
| Provider approvals and question forms | `crates/ade-client/src/request_ui.rs` |
| Standalone Workspace navigation and Agent setup | `crates/ade-client/src/workspace_sidebar.rs` |
| Workspace native-pane layout and feature composition | `crates/ade-client/src/workspace_ui.rs` |
| Workspace entity construction and shared ownership | `crates/ade-client/src/lib.rs` |
| Terminal keyboard/resize adapter and diagnostic CLI | `crates/ade-client/src/bin/attach/terminal_adapter.rs` |
| Native terminal surface and child-window ownership | `crates/ade-platform/src/terminal.rs` and `crates/ade-platform/native/terminal.m` |
| Per-browser update coalescing | `crates/ade-client/src/browser_navigation.rs` |
| Retained standalone browser URL/title updates and task ownership | `crates/ade-client/src/tabs_ui.rs` |
| Client events and reconnects | `crates/ade-client/src/client_state.rs` |
| Durable session operations | `crates/ade-daemon/src/sessions.rs` |
| Database schema and migrations | `crates/ade-daemon/src/store.rs` |
| Worktree lifecycle | `crates/ade-daemon/src/worktrees.rs` |
| Provider protocol implementation | `crates/ade-runtime/src/provider.rs` and provider modules |
| Provider subprocess transport | `crates/ade-runtime/src/rpc.rs` |
| Daemon startup, diagnostics, and worker CLI | `crates/ade-daemon/src/bin/daemon/bootstrap.rs` |
| Application socket serving, admission, and terminal routing | `crates/ade-daemon/src/bin/daemon/server.rs` |
| Supervisor startup and diagnostics CLI | `crates/ade-runtime/src/bin/supervisor/bootstrap.rs` |
| Supervisor ownership, control requests, and connection serving | `crates/ade-runtime/src/bin/supervisor/server.rs` |
| PTY ownership, terminal streams, and subscriber backpressure | `crates/ade-runtime/src/bin/supervisor/terminal_host.rs` |
| Diagnostics and export policy | `crates/ade-platform/src/diagnostics.rs` |
| Installed resource paths | `crates/ade-platform/src/resources.rs` |

## Rust concepts for JS/TS contributors

The desktop executable's `main.rs` only calls `ade_client::run()`. Cargo builds the
implementation as the package's library target. That library keeps feature modules private;
its sole public entry point launches the application. Client tests live in the library target
(`cargo test -p ade-client --lib`), while the complete workspace check also builds both client
executables. Conversation presentation selects its rendered history and composes the
transcript, requests, queue, and composer. The standalone Workspace sidebar owns its
navigation and setup controls; docked chat uses the Shell sidebar instead. These modules
keep the existing Workspace entity and focus handles, rather than recreating editor state
when views render. Workspace rendering retains the standalone native-pane layout.

The daemon and supervisor each have a private executable module tree. Their `main.rs`
calls `bootstrap::run()`. Bootstrap handles diagnostics, CLI modes, and environment
configuration; `server::serve()` owns locks, connections, process admission, and
shutdown. The supervisor's terminal host remains an executable-private module.
This keeps its native terminal parser linkage in the supervisor binary rather than
exposing that implementation through the runtime control library used by the daemon.
Existing server and terminal tests remain binary-target tests.

- A Cargo workspace plays a similar organizational role to a pnpm workspace.
  Each crate declares its dependencies explicitly.
- A `struct` holds fields. An `enum` represents alternatives, similar to a
  TypeScript discriminated union, and `match` handles those alternatives.
- `Option<T>` requires the caller to account for missing values.
- `Result<T, E>` represents success or failure. `?` propagates a failure; it is
  not a JavaScript optional-chain operator.
- Ownership determines who releases a value. `Drop` handles resource cleanup.
  An `Arc<T>` shares ownership across threads; it does not by itself make
  mutation safe. A mutex should protect a small, clearly owned operation.
- A GPUI `Entity<T>` holds model or view state. A `WeakEntity<T>` lets background
  work refer to a view without keeping it alive indefinitely. A late update to
  a released view can be expected cancellation, not an application failure.
- Keep subscription and task handles for their intended lifetime. Do not let
  accidental drops cancel work, or detached work keep a closed view alive.

## Shared presentation rules

`crates/ade-client/src/ui.rs` owns the application palette, repeated dimensions,
type sizes, and common controls. Change these definitions before adding a new
screen-specific value. GPUI Kit supplies control behavior, focus rings, input
editing, and the relative spacing and text utilities.

| Intent | Existing choice |
|---|---|
| Primary interface and chat text | `INTERFACE_PX`, 14 px |
| Dense tabs and sidebar rows | `COMPACT_PX`, 13 px |
| Field labels and compact supporting controls | `LABEL_PX`, 12 px |
| Secondary metadata and recovery hints | `CAPTION_PX`, 11 px; avoid for primary content |
| Code | `CODE_PX`, 13 px, with the theme's monospace font |
| Relative text styles | GPUI Kit `text_sm`, `text_xs`, and heading utilities, based on the theme font size |
| Layout spacing | GPUI Kit spacing utilities; shared component helpers own recurring layouts |
| Rounded controls, cards, composer | `RADIUS`, `CARD_RADIUS`, `COMPOSER_RADIUS` |
| Interface icons | GPUI Kit `IconName`; give icon-only actions an accessible label |

Use semantic palette constants for surfaces and text. The enabled-text contrast
test includes normal, hover, and selected surfaces. It does not prove contrast
for every translucent overlay, syntax token, native view, or disabled state.

Create buttons through the shared helpers. Preserve the toolkit's focus,
disabled, and selected behavior instead of replacing buttons with clickable
containers. Use `row_action` for repeated actions whose target matters to
assistive technology. Use `error_card` for readable recovery text and separately
selectable, bounded details with a complete-copy action.

Motion must finish and must not delay focus or input. lux-ade's shared durations are
120, 180, and 220 ms. The existing motion helpers respect Reduce Motion; some
toolkit popovers own their own entrance timing. Do not animate streaming text or
native terminal/browser surfaces. Native timing, screen-reader, and interaction
checks remain necessary; tokens and unit tests alone do not establish those gates.

## Errors and native code

Use typed errors when callers need to select a recovery action. Add context at
operation boundaries. Preserve failure causes internally without automatically
exposing raw provider text in diagnostics or user-facing messages.

Normal operating failures are not panics. Do not use `catch_unwind` as a general
recovery mechanism. Native faults require careful resource ownership and process
isolation; they cannot all be caught as Rust errors.

The Ghostty surface belongs to the main thread. The native terminal bridge lives in `ade-platform` behind the optional `native-ui`
feature. Its surface and child-window guards cannot cross threads. The client
continues to own GPUI/Wry view coordination. Document ownership and safety requirements at each unsafe
interface, and test focus and cleanup in the actual application.

## Making a change

Choose the owning crate, run its focused checks, then run `scripts/check.sh`.
Protocol changes need compatibility tests. Persistence changes need migration
tests. Native UI changes also need application-level verification. Use the
provider-free preview for component states and fake-provider fixtures for
session behavior before involving a real account.
