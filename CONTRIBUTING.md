# Contributing to lux-ade

lux-ade uses Rust for the desktop, daemon and process runtime, with JS/TS adapters
where provider SDKs require them. The supported desktop target is currently
Apple Silicon macOS 14 or later. Intel, Linux and Windows desktop support are
not yet verified.

## Build

Install Xcode (including its Metal Toolchain), rustup, Python 3.12+, Node.js 22
and pnpm 10. The repository pins Rust in `rust-toolchain.toml`. OMP also needs
Bun 1.4.2; set `ADE_BUN_BIN` if it is not on PATH.

```sh
python3 scripts/bootstrap.py
bash scripts/run.sh --build-only
bash scripts/run.sh
```

Bootstrap downloads checksum-verified sources into `.ade/`, applies the patches
in `patches/`, then builds both Ghostty libraries from the same pinned source.
It records archive and patch fingerprints for installed source trees. A changed
pin or patch fails with instructions to preserve and re-bootstrap the affected
tree. Legacy unstamped trees are compared against freshly fetched, patched source
before adoption; differing local files are never silently accepted. Existing
dependency directories are not overwritten.
To refresh dependencies, first preserve any local edits and move the affected
`.ade` directory aside. Native builds need Xcode's Metal compiler; bootstrap does
not change your Xcode selection or automatically install system components.

For core-only work on another platform:

```sh
python3 scripts/bootstrap.py --sources-only
cargo test --locked -p ade-core
```

`CARGO_TARGET_DIR`, `GHOSTTY_KIT_DIR`, `GHOSTTY_RESOURCES_DIR` and `ADE_ZIG_BIN`
allow explicit build overrides. The scripts respect your existing Rust setup.
Generated resources are ignored by Git.

## Check changes

```sh
bash scripts/check.sh
```

Launch the component preview without a daemon or provider account:

```sh
ADE_UI_SHOWCASE=1 target/debug/ade-client
```

If you override `CARGO_TARGET_DIR`, use that directory instead of `target`.
The preview exposes shared controls, states, typography and motion; it is not a
provider session.

Run the provider's own tests when changing its adapter. Test UI changes in the
component preview and the application; unit tests cannot prove native focus,
input methods or accessibility behavior. Performance checks are in
`scripts/benchmark_runtime.py` and `scripts/check_runtime_benchmark.py`.

## Rust for JS/TS contributors

A Cargo workspace resembles a pnpm workspace. A crate is a package; modules are
namespaces within it. `struct` holds data and `enum` models alternatives.
`Option<T>` means a value may be absent; `Result<T, E>` represents success or
failure. `?` returns an error to the caller rather than throwing an exception.
Ownership and `Drop` make resource lifetimes explicit. Start with ordinary
structs and functions before introducing traits or generic abstractions.

The client owns views and drafts. The daemon owns durable state. The runtime
owns long-lived processes. Keep expensive work off the UI thread and do not
make closing a view implicitly stop a provider process.

Do not commit credentials, user conversations, local logs or generated app
bundles. Public repository ownership, project licensing and release signing
identity remain pending project decisions.

## Pinned development tools

```sh
python3 scripts/install_tools.py
bash scripts/check.sh
bash scripts/check_dependencies.sh
```

The installer verifies official release archive checksums and puts
cargo-nextest 0.9.145 and cargo-deny 0.20.2 in `.ade/tools/bin`. Versions and
supported host archives are recorded in `scripts/tools.json`; no global tools
are replaced. The check scripts add this directory to PATH themselves.
For another host, use `cargo install --locked --version <pinned-version>` for
the required tool and keep it on PATH.

Nextest runs unit and integration tests in isolated processes with no automatic
retries; doctests still run through Cargo. `.config/nextest.toml` defines the CI
profile and a timeout for hung tests. See the [official installation guide](https://nexte.st/docs/installation/from-source/)
and [configuration guide](https://nexte.st/docs/configuration/).

The dependency gate checks RustSec advisories, yanked crates, wildcard
requirements and dependency sources. Duplicate versions are reported as warnings
because the current native dependency graph contains multiple versions by design.
Unknown registries and Git sources are denied. Source archives fetched by our
bootstrap are covered separately by pinned checksums and reviewed patches.
The gate has no advisory ignore entries. Unmaintained-package notices remain
warnings; known vulnerability and unsoundness advisories remain blocking.
Current maintenance findings and upstream migration paths are tracked in
[dependency-maintenance.md](docs/dependency-maintenance.md).

The license check is intentionally separate until a distribution policy is
selected; running the configured checks does not establish license clearance.
See [cargo-deny's official guidance](https://embarkstudios.github.io/cargo-deny/)
and `THIRD_PARTY_NOTICES.md` for the inventory boundary.

Agent guidance discovery: nextest publishes an `AGENTS.md` for contributors to
its own repository; lux-ade integrates its CLI rather than modifying nextest.
The checked cargo-deny repository did not publish an `AGENTS.md`, and its docs
`llms.txt` endpoint was absent. The ordinary official documentation above is the
integration reference.

For failure symptoms, profile inspection and recovery commands, see
[troubleshooting](docs/troubleshooting.md).
