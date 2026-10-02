# Third-party source notices

ADE has not selected its own project license. This file records verified native
source provenance; it is not a completed audit of every Rust crate, provider
package, bundled font, or other transitive resource.

| Component | Pinned source | License file verified in source |
| --- | --- | --- |
| GPUI Kit | [Longbridge, ce9267130ae030db4fc3bdec263212a0ab16045c](https://github.com/longbridge/gpui-kit/tree/ce9267130ae030db4fc3bdec263212a0ab16045c) | `LICENSE-APACHE`, Apache-2.0 notice |
| GPUI macOS platform | [gpui-pre-macos 0.3.6](https://crates.io/crates/gpui-pre-macos/0.3.6), derived from Zed revision bcf6582ce3500df93a8a39366640173e6786cea6 | `LICENSE-APACHE`, Apache-2.0 |
| Ghostty terminal renderer and parser | [Herdr vendored source, 9c96f7ddb3be2cc575a159d4d1f1d49fb10d7006](https://github.com/herdrdev/herdr/tree/9c96f7ddb3be2cc575a159d4d1f1d49fb10d7006/vendor/libghostty-vt) | `LICENSE`, MIT, Mitchell Hashimoto and Ghostty contributors |

The fetched sources retain their license files. Download URLs and archive
checksums are in `native/dependencies.json`. ADE modifications are retained as
reviewable files in `patches/`; they do not remove upstream notices.

Packaging collects license, notice, copyright, and copying files found in these
source trees, including their vendored subdirectories. It puts the original
texts in `Contents/Resources/third-party/licenses`, with their paths and SHA-256
checksums in `third-party-inventory.json`. That inventory says what was found;
it does not assert that no additional obligations exist.

A complete transitive Rust/provider/resource inventory and distribution review
remain release gates. Do not infer that the three licenses above cover the
entire application bundle. Historical prototype notices under `native/` are
retained as provenance and are not a current comprehensive inventory.

Patch purposes, upstream status, verification methods and remaining reused-source
gaps are recorded in [the vendor patch ledger](docs/vendor-patches.md). The
OpenCode provider plugin retains OpenCode's upstream MIT notice, for its reduced protocol
fixture, in `plugins/opencode/LICENSE-opencode`; see its adjacent `PROVENANCE.md`.

Packaging also produces a resolved Cargo inventory with available Rust source
notices. See [build and release](docs/build-and-release.md#rust-notice-inventory)
for its target/features/build/dev scope and unresolved-text reporting. The
inventory records evidence; it does not select SPDX alternatives or complete a
license compatibility review.

The installed provider inventory retains package declarations, pnpm lockfiles and
available notice texts separately. Its [documented scope](docs/build-and-release.md#installed-provider-notice-inventory)
includes unresolved evidence and does not establish distribution clearance.

Native archive inputs, copied resources, GPUI icons and available cached Zig
source notices are recorded in `native-resource-inventory.json` during packaging.
See the [native/resource scope and remaining gaps](docs/build-and-release.md#native-and-resource-evidence-inventory).
This supersedes relying on historical binary-package notices as current evidence;
it does not establish exact static linkage or license clearance.

## Pinned resource notice supplements (2026-09-25)

`native/notices/provenance.json` pins retained upstream texts by source URL,
revision where applicable, and SHA-256. Packaging verifies those hashes before
copying texts into `third-party/licenses/supplemental/`. It also copies the
provenance record. Packaging makes no network request for these supplements.

- **Themes:** The Ghostty theme cache contains 607 files and no license file.
  All 607 file contents match Git blob identities under `ghostty/` at
  [iTerm2-Color-Schemes revision 752a9c079396cc9939b86e893578ed81e80c140f](https://github.com/mbadolato/iTerm2-Color-Schemes/tree/752a9c079396cc9939b86e893578ed81e80c140f/ghostty).
  The MIT notice at that same revision is retained in `native/notices/themes/LICENSE`.
  The proof records the exact cached archive SHA-256 and upstream subtree ID;
  the collector applies it only when the inspected cache hash matches. This
  resolves the missing root theme notice for this pin, not arbitrary future pins
  or a per-theme originality/legal audit.
- **Nerd Fonts:** The Ghostty archive provides the project MIT license but not
  the full glyph-set notice collection. Additional upstream texts supplied by
  [v3.4.0 revision fa7b859994228a9c8759f99c55a8d31ee92a1b5e](https://github.com/ryanoasis/nerd-fonts/tree/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/src/glyphs)
  are now retained: Codicons, Font Awesome, Material Design, Octicons, Pomicons,
  Powerline Extra, Powerline Symbols and Weather Icons. The pinned audit and
  glyph README are retained as evidence, not adopted as ADE legal advice.
  Upstream's [SymbolsOnly licensing discussion](https://github.com/ryanoasis/nerd-fonts/discussions/1908)
  confirms that the root MIT label does not cover every icon license. Missing
  notices for other contributing glyph sets, exact embedded glyph mapping and
  potentially outdated audit entries remain unresolved. No single license is
  assigned to the composite font by this inventory.
- **Shell integration:** Actual pinned bash `ghostty.bash`, zsh
  `ghostty-integration` and zsh `.zshenv` headers declare GPL version 3 or later
  and identify Kitty-derived material. Packaging preserves these source files
  and associates them with the full [GNU GPLv3 text](https://www.gnu.org/licenses/gpl-3.0.txt),
  retained in `native/notices/GPL-3.0.txt` with a verified local hash. This is
  notice retention; attribution, corresponding-source and distribution review
  remains separate. It does not select a license for ADE's own code.

These supplements improve the earlier cached-source inventory. They do not
establish exact static linkage, resolve every native/provider/font obligation,
or constitute approval to distribute the application.
