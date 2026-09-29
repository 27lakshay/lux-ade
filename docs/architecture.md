# ADE architecture as built

This page maps the current code. [CONTEXT.md](../CONTEXT.md) defines the product terms. The
[v1 specifications](../.scratch/ade-v1/README.md) state intended behavior; the
[architecture proposal](proposed-architecture.md) records decisions and remaining scope. The
removed GPUI client is documented in [prototype history](prototype-history.md).

## Process ownership

```text
Electron renderer ── typed preload ── Electron main ── @ade/client ── ade-daemon ── SQLite
        │                    │                              │
        └── MessagePort ── stream bridge                   └── ade-runtime ── providers, PTYs, services

ade CLI ──────────────────────────────── @ade/client ──────┘
```

- **The daemon** owns durable records, application rules, operation admission, receipts and the
  change feed. It stores profile data in SQLite and controls the runtime.
- **The runtime** owns live provider processes, terminal PTYs and managed services. Its work can
  outlive an Electron window.
- **The SDK** validates requests and replies against generated contracts, applies the daemon's
  feed, reconnects, and journals client requests the daemon has not admitted yet. It imports
  neither React nor Electron.
- **Electron main** creates windows for daemon window records, owns native menus and browser
  pages, and forwards typed requests. Browser tab records and their local receipts still live in
  Electron; [browser ticket 09](../.scratch/daemon-authority/issues/09-browser-tab-records.md)
  describes their approved move to the daemon.
- **The renderer** draws daemon state and sends commands when gestures end. It keeps pointer,
  keyboard focus, scrolling and mounting policy locally. It reads the host only through the
  typed preload API.
- **The stream bridge** is an Electron utility process. A MessagePort carries conversation feed
  frames and terminal output directly to each window, batched once per frame. Ordinary commands
  remain on the typed request bridge.

## Where changes belong

| Change | Start here |
|---|---|
| A product identity or wire operation | `crates/ade-core/src/model.rs`, `crates/ade-core/src/contract/` |
| A generated TypeScript contract | Change Rust contracts, then run `pnpm contract:generate`; inspect `packages/contracts` |
| A durable rule, window, layout or workspace lifecycle | `crates/ade-daemon/src/sessions/`, `crates/ade-daemon/src/store/` |
| An effect-command receipt | `crates/ade-daemon/src/receipts.rs` and the owning handler |
| A provider process, PTY or service execution | `crates/ade-runtime/src/` and `providers/` |
| A CLI command or client retry/reconciliation rule | `apps/cli/src/`, `packages/client/src/` |
| An Electron window, native menu or browser page | `apps/desktop/src/main/` |
| A renderer request or stream | `apps/desktop/src/shared/`, `src/preload/`, `src/main/` or `src/stream-bridge/` |
| A workspace gesture or component | `apps/desktop/src/renderer/src/features/workspace/` |
| A terminal view or restore | `packages/terminal/src/`, `apps/desktop/src/renderer/src/features/workspace/terminals/` |

Each operation declares a query, idempotent-command or effect-command tier in its Rust contract.
Only effect commands carry an operation ID, daemon-computed fingerprint, receipt and
reconciliation. `packages/contracts` is generated from those Rust types.

## Windows, layouts and terminal views

The daemon records windows and one revisioned layout per window and workspace. Its layout core
applies `layout.apply`; `tab.close` and `pane.close` handle closure that can stop a terminal.
The renderer's layout store holds daemon replies and sends a command at the end of a gesture.
The layout's pane tree is a value within the layout record, while projects, workspaces,
conversations, terminals and windows have their own stable IDs.

A terminal tab points at a workspace-owned terminal record. The runtime runs its process. The
desktop attaches through the stream bridge; `packages/terminal` uses Ghostty WebAssembly built
from the same pinned Ghostty source as the daemon's native terminal state. Output stays outside
React state. The CLI's terminal attachment can still request `xterm-replay-v1`; this does not
describe the desktop renderer.

The workspace shell, navigator, tabs, splits and terminal pane content are built. The production
renderer currently returns no content for conversation, browser, file or diff pane targets.
The `?bench` development mode supplies synthetic conversation content for measurement; it is not
the production conversation surface.

## Verification

`pnpm check:static` runs formatting, contract and architecture checks, builds, typechecking,
lint, dead-code checks, in-process JavaScript and renderer tests, Clippy and Rust tests. It does
not run the built-desktop or protocol E2E suites. Use `pnpm test:e2e:protocol` for real daemon
and runtime behavior, and `pnpm test:e2e:desktop` for Electron flows with scratch profiles and
provider mocks. See each suite's README before adding a spec.
