# Build and release boundaries

The [contributor guide](../CONTRIBUTING.md) covers development. The current macOS packaging
command is `pnpm package:mac`, implemented by `scripts/package-macos.mjs` and
`electron-builder.yml`. The [GPUI packaging record](build-and-release-history.md) is historical;
its Python package and release scripts do not build the Electron app.

## Current package

`package:mac` builds the TypeScript packages and Rust daemon/runtime binaries, stages the CLI,
SDK, contracts, provider bridges and plugin host, then calls electron-builder for an unpacked
macOS `.app` under `dist/electron/`. The package includes `ade-control`, `ade-daemon` and
`ade-runtime`, a CLI launcher, and a pinned Bun executable for provider bridges. The packaged
Electron executable can run as Node for the CLI and provider workers; that setting is scoped to
those processes so terminals and services do not inherit it.

The bundled Codex public worker is staged with `pnpm --filter ade-codex-worker
deploy --prod` and its workspace dependency closure. That closure contains the
provider SDK, generated contracts and pinned Effect packages. It must initialize
outside the source checkout without resolving the checkout's `node_modules`.
The native translator runs from the packaged `ade-runtime`; Node owns and
closes that helper. A filtered production deployment and native-free initialize
smoke establish dependency closure, not signing or full-bundle release readiness.

The current builder target is `dir`, with no Developer ID signing identity and no public
publication step. An ad-hoc signature lets the unsigned Apple Silicon build launch after its
Electron fuses are set. This is a development artifact, not a signed public release.

## Release work still required

- Build and test from a clean checkout on the supported Mac, then launch the unpacked app from
  outside the checkout. Run the [packaged E2E suite](../playwright.package.config.ts).
- Exercise a real conversation, terminal, browser, reconnect and daemon/runtime restart in the
  package. The conversation and browser pane surfaces are not built yet.
- Verify provider prerequisites, package size and third-party notices from the actual staged
  Electron bundle. The old GPUI notice inventories do not establish its contents.
- Choose a project license, public repository and signing identity. Test signed artifacts,
  notarization and Gatekeeper on a separate Mac before claiming a public release.
- Define post-release schema upgrades, rollback boundaries and any automatic update channel
  before shipping one. The current [prelaunch compatibility rule](compatibility.md) deliberately
  has no migration path for old development profiles.

Native sources and patches are pinned in `native/dependencies.json` and
[`patches/`](../patches/); [vendor-patches.md](vendor-patches.md) distinguishes the active Ghostty
patch from retained GPUI prototype patches. Keep the package's lockfiles, native provenance and
matching debug information for any future distributed build.
