# Contributing to ADE

ADE's desktop is Electron/React. A Rust profile daemon owns application state; a separate Rust
runtime owns provider processes, terminals and services. The supported desktop target is Apple
Silicon macOS. The Rust toolchain is pinned in `rust-toolchain.toml`, and the JavaScript package
manager in `package.json`.

## Set up and run

Install Xcode and its Metal toolchain, Rust through rustup, Python 3.12 or later, Node.js and
pnpm. Some provider adapters also need their own executables; Oh My Pi uses Bun. From the repo
root:

```sh
pnpm install --frozen-lockfile
python3 scripts/bootstrap.py
pnpm dev
```

Bootstrap fetches pinned native sources and checks their archive and patch fingerprints. It
does not overwrite an existing source tree with local changes. `pnpm dev` builds the SDK, CLI,
daemon and runtime, then opens the desktop with renderer hot reload. It uses a development
profile under `.ade/dev-profiles-v2` unless `ADE_SOCKET` names another endpoint. See
[desktop debugging](docs/agents/desktop-debugging.md) for restarting processes and inspecting
the running app.

For work on the shared Rust core without launching Electron:

```sh
cargo test --locked -p ade-core
```

`CARGO_TARGET_DIR`, `ADE_ZIG_BIN` and the native source overrides can select another build
location or toolchain. The build scripts do not change Xcode selection or install system tools.

## Check changes

```sh
pnpm check:static
```

This required gate checks formatting, contracts, architecture, API parity, builds, TypeScript,
lint, dead code, JavaScript and renderer tests, Clippy and Rust tests. Protocol and desktop E2E
run separately:

```sh
pnpm test:e2e:protocol
pnpm test:e2e:desktop
```

The [protocol suite](e2e/protocol/README.md) starts real daemon and runtime processes with
scratch profiles and provider mocks. The [desktop suite](e2e/desktop/README.md) launches the
built Electron app against the same kind of scratch backend. Inspect the running app after a UI
change; tests alone do not show every pointer, focus or drawn-state regression.

## Where work belongs

Read the [current architecture](docs/architecture.md) for the ownership map and
[CONTEXT.md](CONTEXT.md) for ADE's terms. [AGENTS.md](AGENTS.md) routes work to the relevant
guidance. Contracts originate in Rust and are generated into `packages/contracts` with
`pnpm contract:generate`.

The v1 [requirements register](.scratch/ade-v1/requirements.md) and domain specs describe
intended behavior. They do not certify that a feature is implemented. The removed GPUI app,
its `ade-client` executable, `scripts/run.sh`, and the Python demo are historical; see
[prototype history](docs/prototype-history.md).

Keep credentials, conversations, local logs and generated bundles out of commits. The project
license, public repository ownership and release signing identity remain undecided. For profile
inspection and diagnostics, see [troubleshooting](docs/troubleshooting.md).
