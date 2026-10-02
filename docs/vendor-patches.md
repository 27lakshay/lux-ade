# Vendor patches and reused-source provenance

The patch inventory is complete for the four patch files currently retained in
this repository. Only the Ghostty patch is used by the current Electron native build;
the GPUI patches belong to the removed prototype. The distribution license audit is not
complete. No upstream submission is recorded for these lux-ade patches; this ledger does not claim a search
of every upstream issue or pull request. Reviewed against source on 2026-09-25.

## Pins and ownership

| Patch | Pinned base and provenance | Status |
| --- | --- | --- |
| `patches/gpui-kit.patch` | Longbridge GPUI Kit `ce9267130ae030db4fc3bdec263212a0ab16045c`, Apache-2.0; lux-ade changes to thirteen files | Historical prototype patch; not consumed by current bootstrap |
| `patches/gpui-pre-macos.patch` | crates.io `gpui-pre-macos` 0.3.6, derived from Zed `bcf6582ce3500df93a8a39366640173e6786cea6`, Apache-2.0; lux-ade callback fix and example | Historical prototype patch; not consumed by current bootstrap |
| `patches/ghostty.patch` | Herdr `9c96f7ddb3be2cc575a159d4d1f1d49fb10d7006`, `vendor/libghostty-vt`, MIT Ghostty source; lux-ade renderer changes | Active local patch; no submission recorded |
| `native/ghostty-snapshot.patch` | Same Herdr vendored source; earlier lux-ade renderer patch | Historical, superseded by `patches/ghostty.patch`; not consumed by bootstrap; no submission recorded |

Archive URLs, SHA-256 hashes and extraction roots live in
[`native/dependencies.json`](../native/dependencies.json). The current bootstrap fetches only
Ghostty sources. The parser uses the unpatched Herdr vendor source. The renderer uses that same base plus
`patches/ghostty.patch`. Do not treat the Herdr repository commit as an upstream
Ghostty commit or as a license covering all of Herdr.

## Purpose and verification

| Patch area | Purpose | Verification method |
| --- | --- | --- |
| GPUI base dock panel/tab group | Explicit focus request callback, including reselection of the active tab, lets native surfaces acquire first responder | Native terminal/browser focus and repeated-tab-selection interaction checks |
| GPUI base resizable state | Apply owner-computed geometry without replacing slots or emitting drag events; reject invalid sizes | Patched `owner_geometry_preserves_slots_identity_and_emits_no_resize` test |
| GPUI base inline text | Release obsolete shaped layouts; skip glyph-position work outside the viewport | Patched retained-layout assertion and `invisible_wrapped_rows_do_not_measure_glyph_positions` test; inspect performance separately |
| GPUI base text selection | Preserve nonempty whitespace-only selections and selected whitespace in Copy handlers, while removing the synthetic separator after the last selected document block | lux-ade rendered chat drag, whitespace selection, and Cmd-C regressions; temporarily restoring the old filters or document separator reproduces the respective failures; native chat drag/copy check |
| GPUI component panel/tab panel/tab/context menu | Per-tab context menus, accessible names, native overlay visibility callback, panel options access; bypass paint cache while accessibility is active | Patched context-menu callback test; lux-ade native menu dismissal, tab actions, accessibility-tree and focus checks |
| GPUI language highlighter | Compose JavaScript/JSX captures with TypeScript/TSX queries | lux-ade rendered syntax-span tests; query compilation alone does not prove correct spans |
| GPUI macOS platform | Drop platform mutex before restoring menu callbacks even when native tags have no matching GPUI action | Patched `menu_callback_regression` example in both `validate` and `handle` modes; watchdog bounds hangs; tests unmatched tags, callback retention and reentry |
| Ghostty header/embedded renderer | Add snapshot restore, ordered output feed and daemon-authoritative grid resize APIs | Rebuild parser and renderer from the same pin; binary transport reconnect/order tests; native restore and resize checks |
| Ghostty Termio/stream handler | Isolate externally restored view from subprocess output; avoid duplicate VT responses and clipboard escape effects; preserve input path | Native query/clipboard isolation and input checks; `scripts/test_binary_transport.py` checks transport ordering, not every native effect |
| Ghostty SharedGrid | Bounded per-thread font/glyph cache with lifetime identity to avoid stale pointer-reuse hits | Patched `lux-ade local font cache matches shared lookups and survives grid replacement` Zig test, plus renderer comparison/performance checks |
| Ghostty Metal Frame | Optional GPU command-buffer timing instrumentation | Opt-in trace sanity checks; GPU execution timing does not measure presentation latency |
| Historical Ghostty patch | Earlier snapshot/feed/resize, isolation, font cache and GPU timing implementation in the same six source files | Do not apply on top of the active patch. Retained for history; current verification targets the active patch |

Bootstrap verifies downloaded archive hashes and `git apply --check` before
applying patches. `.ade/source-metadata` records archive and patch fingerprints.
An existing mismatched pin fails without overwriting it; unstamped trees must
match a freshly extracted and patched source tree. The regression suite covers
parent Git repository discovery, which otherwise allowed `git apply` to skip
nested source paths. These checks establish reproducibility, not runtime safety.
Native snapshots remain a version-pinned experimental boundary, not an audited
untrusted remote-data protocol. See [native notes](../native/README.md).

## Reused source versus design references

| Material | Classification and evidence | Coverage / next action |
| --- | --- | --- |
| GPUI Kit and macOS platform | Actual fetched source, with lux-ade modifications above | Original notices retained; packaged inventory records found notice paths and hashes |
| Herdr vendored libghostty-vt | Actual fetched parser and renderer source, including inherited snapshot implementation | Ghostty MIT retained; enumerate nested native dependencies and resource licenses before distribution |
| OpenCode plugin `test/fixtures/protocol-fixture.mjs` | Reduced schema contracts derived from evaluated API source and installed schema | Upstream MIT notice retained in the plugin; audited checkout/files, the v2.0.22 schema capture hash and the missing v2.0.3 capture documented in [plugin provenance](../plugins/opencode/PROVENANCE.md) |
| `crates/ade-platform/native/terminal.m` | Native README identifies original lux-ade integration using Ghostty's embedding API; Ghostex surface ownership is a design reference | This is recorded authorship, not a completed line-by-line originality audit |
| Orca, Paseo, T3Code, Ghostex and OpenCode architectural patterns | Design references for docking/focus, connection lifecycle, diagnostics, renderer isolation and client/server boundaries | References do not establish copied source. If code is imported later, record repository revision, file, modifications and notice at import time |
| Oh My Pi, Claude SDK and other provider packages | Actual packaged dependencies identified by provider package manifests/lockfiles | Dependency/source/resource notice audit still needed; package presence does not license lux-ade's own code |
| Historical libghostty-spm notices | Records from an earlier binary experiment; current build does not link that binary | Retain as history; do not use its dependency list as proof of the current source build's contents |

## Remaining distribution work

- Inventory Cargo.lock dependencies, provider pnpm dependency graphs, native Zig
  manifests including nested packages, compiled fonts, icons and copied resources.
  The current filename-based collector covers native source trees only and can
  miss nonstandard notice names and downloaded build dependencies.
- Verify current Ghostty resource obligations separately from its MIT source
  license. The actual bash integration header declares GPL-3.0-or-later, and
  packaging copies the installed Ghostty resource tree wholesale. Check zsh
  integration headers, retain all required texts, and verify source availability.
  This document does not decide license compatibility or distribution conditions.
- Determine which optional/static native dependencies are linked in the actual
  macOS artifact. The historical libghostty-spm notice mentions libintl; that is
  not evidence that the current build links it.
- The original OpenCode v2.0.3 schema capture is not recoverable; the v2.0.22
  capture hash is recorded in the plugin provenance. Preserve each capture and its
  checksum on the next fixture refresh.
- Complete a source-origin review for lux-ade-authored files before claiming no other
  copied code. This audit inspected explicit provenance markers and build inputs;
  it was not a whole-codebase similarity comparison against every contender.
- Choose lux-ade's own license only after that review. No project license is selected
  or implied by this ledger.
