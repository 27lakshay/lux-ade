# Third-party notices

ADE includes code adapted from the projects below. Each entry names the source
repository and snapshot, its licence, and the ADE files that contain adapted code.
Those files carry a `Portions adapted from` header.

The licence texts that apply are MIT and Apache-2.0. An entry under Apache-2.0
also records that the adapted files were modified.

<!-- Add one section per source repository, in this form:

## <repo> (<licence>)

Source: <upstream URL> at <snapshot commit>
Copyright: <holder line from the source LICENSE>

| ADE file | Source path | Changes |
|---|---|---|

-->

## Orca (MIT)

Source: https://github.com/stablyai/orca at `b7a4fee7`
Copyright: Copyright (c) 2026 Lovecast Inc.

| ADE file | Source path | Changes |
|---|---|---|
| `crates/ade-daemon/src/observability/redact.rs` | `src/main/observability/redactor.ts` | Ported to Rust: key-family blocklist, labeled key-value rule, provider-key fingerprints with tagged replacements, URL userinfo stripping |
| `apps/desktop/src/main/browser-diagnostics-core.ts` | `src/main/observability/redactor.ts` | Adapted: labeled key-value rule, provider-key patterns, URL userinfo rule |
| `crates/ade-daemon/src/devices.rs` | `src/main/emulator/simctl-simulator-devices.ts`, `src/main/emulator/android/adb-devices.ts`, `avd-manager.ts`, `android-sdk-discovery.ts`, `android-device-inventory.ts` | Ported to Rust: simctl JSON shape, `adb devices -l` grammar, AVD list filter, SDK root order |

## t3code (MIT)

Source: https://github.com/pingdotgg/t3code at `e4eb9977`
Copyright: Copyright (c) 2026 T3 Tools Inc.

| ADE file | Source path | Changes |
|---|---|---|
| `crates/ade-daemon/src/checkpoints.rs` | `apps/server/src/vcs/GitVcsDriver.ts` | Ported to Rust: checkpoint commit and restore through Git plumbing |
| `crates/ade-daemon/src/usage/core.rs` | `apps/server/src/provider/Layers/CodexAdapter.ts`, `apps/server/src/provider/Layers/claudeUsageLimits.ts` | Ported to Rust: per-turn deltas of the Codex token total; units of Claude's rate-limit event |
| `packages/terminal/src/ghostty/runtime.ts` | `apps/web/src/terminal/ghostty/runtime.ts` | Adapted: current libghostty-vt allocators and layout JSON; no write-PTY trampoline; replaceable byte source |
| `packages/terminal/src/ghostty/core.ts` | `apps/web/src/terminal/ghostty/core.ts` | Adapted: current libghostty-vt ABI; no terminal replies; daemon scrollback limit; snapshot restore; unused members removed |
| `packages/terminal/src/ghostty/surface.ts` | `apps/web/src/terminal/ghostty/surface.ts` | Adapted: byte writes, snapshot restore, ADE class and variable names; unused members removed |
| `packages/terminal/src/ghostty/renderer.ts`, `keyCodes.ts` | `apps/web/src/terminal/ghostty/renderer.ts`, `keyCodes.ts` | Copied |
| `packages/terminal/src/ghostty/links.ts` | `apps/web/src/terminal-links.ts` | Adapted: imports |
| `packages/terminal/src/ghostty/support.ts` | `apps/web/src/lib/utils.ts`, `apps/web/src/lib/selectionActions.ts`, `apps/web/src/appearanceFonts.ts`, `packages/client-runtime/src/markdownLinks.ts` | Extracted: the helpers the terminal needs |
| `packages/terminal/src/ghostty/*.test.ts` | `apps/web/src/terminal/ghostty/*.test.ts` | Adapted: Vitest browser mode; no terminal replies; the ABI test rewritten for the current libghostty-vt |

## Bundled binaries and fonts

These ship unmodified, or compiled unmodified from source, next to their licence.

| ADE file | Project and licence | Source |
|---|---|---|
| `packages/terminal/src/ghostty/vendor/ghostty-vt.wasm` | Ghostty's libghostty-vt (MIT), Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors | Compiled by `scripts/build-ghostty-wasm.mjs` from the libghostty-vt in herdr at the commit `native/dependencies.json` pins (`vendor/VERSION`) |
| `packages/terminal/src/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2` | Nerd Fonts Symbols (MIT), Copyright (c) 2014 Ryan L McIntyre; licence in `fonts/LICENSE` | https://github.com/ryanoasis/nerd-fonts |

## Paseo (Apache-2.0)

Source: https://github.com/getpaseo/paseo at `c356394`
Copyright: Copyright (c) 2025-present Mohamed Boudra

The files below were modified from the original. The Apache License 2.0 text
must ship with any distribution that includes them.

| ADE file | Source path | Changes |
|---|---|---|
| `crates/ade-runtime/src/terminal_ownership.rs` | `packages/server/src/terminal/terminal-size-ownership.ts` | Modified: ported to Rust; added input-driven transfer, ranked hand-off on detach and incarnation fencing |
| `apps/desktop/src/main/browser-automation-core.ts` | `packages/desktop/src/features/browser-automation/actionability.ts` | Modified: the actionability loop now takes a selector lookup instead of a snapshot reference |
