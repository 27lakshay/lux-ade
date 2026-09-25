# lux-ade

lux-ade is a native desktop workspace for working with coding agents, terminals,
projects, and an optional embedded browser. The interface uses Rust and GPUI;
a separate daemon owns durable application state, and a runtime supervisor owns
long-lived processes.

**Status:** under active development. The production and open-source plan is
being implemented; public release readiness has not been established.

## Build and run

The currently supported desktop build is Apple Silicon macOS. Start with
[Contributing](CONTRIBUTING.md) for prerequisites and exact commands.

```sh
python3 scripts/bootstrap.py
bash scripts/run.sh
```

Bootstrap fetches pinned native sources and applies the patches in `patches/`.
It does not require the original author's development directory. Node, Bun,
Python, and provider-specific tools remain documented runtime prerequisites.

For an interactive chat workflow without any provider account, see the [local demo](docs/demo.md).

For UI development without starting a provider:

```sh
bash scripts/run.sh --build-only
ADE_UI_SHOWCASE=1 target/debug/ade-client
```

If you set `CARGO_TARGET_DIR`, substitute that directory for `target`.

## Source map

| Crate | Responsibility |
|---|---|
| `ade-core` | Shared models, provider contracts, validation, and protocol types |
| `ade-client` | GPUI windows, chat, panes, inputs, and daemon connection |
| `ade-daemon` | Durable sessions, SQLite, worktrees, review, and services |
| `ade-runtime` | Provider transport, process supervision, and terminal runtime |
| `ade-platform` | Resource locations, private diagnostics, and instrumentation |

The client does not depend on daemon or runtime implementation crates. Native
terminal integration is still being moved behind a narrower platform interface.
JS/TS provider adapters live in `providers/` and use pnpm where dependencies are needed.

## Development status

- [Complete v1 specifications and requirements register](.scratch/ade-v1/README.md) — local Markdown tracker; all 140 catalogue dispositions and E2E acceptance
- [Monorepo initialization plan](docs/monorepo-initialization-plan.md) — React/Electron, xterm.js, Fallow, and end-to-end-only testing
- [Proposed Electron and Rust architecture](docs/proposed-architecture.md) — design for the successor; not yet implemented
- [Full production and open-source plan](docs/production-and-open-source-plan.md)
- [Implementation task list and evidence](docs/implementation-task-list.md)
- [Build and release workflow](docs/build-and-release.md)
- [Architecture and contribution map](docs/architecture.md)

New tabs and split panes offer Conversation, Terminal, or Browser. Browsers are
lazy. Provider conversations use a GUI; provider CLIs can run independently in
terminals.

## Diagnostics

Local logs retain bounded operational metadata, not raw provider stderr or chat
payloads. Export an inspectable report explicitly:

```sh
target/debug/ade-client --export-diagnostics /tmp/ade-diagnostics.json
```

The destination must not already exist. `ADE_LOG_DIR` overrides the log directory.

## Distribution

Project licensing, public repository ownership, and release signing credentials
are deferred decisions. No signed public release is claimed. See the release
workflow for preparing and validating local artifacts.
