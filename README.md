# lux-ade

ADE is a desktop workspace for coding agents, terminals and projects. Its Electron/React app
shows state owned by a Rust profile daemon. A separate Rust runtime owns provider processes,
terminals and services. The CLI and TypeScript SDK use the same daemon API.

**Status:** under active development. The desktop workspace shell and real terminal surface are
built; conversation, browser, file and diff pane content is still being built. Public release
readiness has not been established.

## Build and run

The current desktop target is Apple Silicon macOS. See [Contributing](CONTRIBUTING.md) for
prerequisites. From the repository root:

```sh
pnpm install --frozen-lockfile
python3 scripts/bootstrap.py
pnpm dev
```

`pnpm dev` builds the SDK, CLI, daemon and runtime, starts a development profile when needed,
and opens the Electron app with renderer hot reload. The provider mocks used by automated tests
need no provider account. The older [GPUI demo](docs/demo.md) is historical.

## Source map

| Area | Responsibility |
|---|---|
| `apps/desktop` | Electron main, preload, stream bridge and React UI |
| `apps/cli` | CLI over the public daemon operations |
| `packages/client` | Framework-neutral SDK, synchronization and client journals |
| `packages/contracts` | Generated TypeScript contracts and validators from Rust |
| `packages/terminal` | Ghostty WebAssembly terminal surface |
| `crates/ade-core` | Shared models, contracts and pure layout logic |
| `crates/ade-daemon` | Durable application state, rules and receipts |
| `crates/ade-runtime` | Provider processes, PTYs and services |

See the [current architecture map](docs/architecture.md) for ownership and code paths.

## Development status

- [V1 specifications and requirements register](.scratch/ade-v1/README.md) record intended scope and acceptance, not implementation status.
- [Current architecture](docs/architecture.md) maps the code and names unbuilt desktop surfaces.
- [Daemon authority evidence](.scratch/ade-v1/evidence/daemon-authority.md) records completed backend and desktop integration checks.
- [Build and release boundaries](docs/build-and-release.md) describe the current package command and outstanding release work.
- [Historical plans](docs/prototype-history.md) preserve the GPUI prototype and earlier architecture choices.

The workspace shell offers tabs and split panes. Terminal tabs render today. Conversation,
browser, file and diff pane surfaces remain open UI work; their backend operations can be driven
through the CLI and SDK.

## Diagnostics

The daemon can export diagnostics without starting its server:

```sh
target/debug/ade-daemon --export-diagnostics /tmp/ade-diagnostics
```

Inspect the report before sharing it. See [troubleshooting](docs/troubleshooting.md) for profile
selection and development logs.

## Distribution

Project licensing, public repository ownership, and release signing credentials
are deferred decisions. No signed public release is claimed. See the release
workflow for preparing and validating local artifacts.
