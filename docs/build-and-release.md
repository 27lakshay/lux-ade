# Build and release boundaries

The contributor path is in [CONTRIBUTING.md](../CONTRIBUTING.md). Native sources
are pinned in `native/dependencies.json`; checksums cover the downloaded archives.
`patches/gpui-kit.patch` contains lux-ade's dock/focus/accessibility changes.
`patches/gpui-pre-macos.patch` contains native menu safety fixes.
`patches/ghostty.patch` contains the snapshot/feed/resize embedding extension,
query ownership, GPU instrumentation and font-cache contention fixes. The parser
and renderer use the same Herdr-vendored Ghostty revision.

The bootstrap keeps source separate from native output. It never modifies a
reference clone and does not overwrite existing dependency directories. The
`.ade` directory is disposable build state only after preserving local changes.
Local changes to dependencies belong in reviewed patches before release.

## Packaging

`python3 scripts/package.py --profile release` packages all four executables,
provider bridges and their installed dependencies, UI assets, terminal theme,
Ghostty resources and terminfo. Provider dependency links are preserved only after verifying that they stay
inside the bundle; generated command shims use relative resource paths. Provider runtimes
(Node/Bun) and externally configured provider CLIs remain explicit prerequisites;
this is not yet a self-contained runtime installer.

Release packaging derives a build ID from the four target executable hashes,
preserves matching dSYM bundles under `dist/symbols/<build-id>/`, and verifies
Mach-O UUIDs before stripping debug symbols from packaged copies. Original
Cargo target binaries remain untouched. Missing debug symbols fail packaging
before stripping. Keep the symbol archive for every shipped build.

`Resources/build-manifest.json` records source and unsigned packaged binary
hashes, UUIDs, dSYM hashes, and lockfile/native-manifest hashes. Developer ID
signing changes binary bytes afterward; the final ZIP checksum covers the signed
artifact. The bundle also retains native source license texts and their hashes.

`bash scripts/release.sh --unsigned` creates an app ZIP, a separate symbols ZIP,
and SHA-256 files for both.
Unsigned artifacts are development artifacts, not public production releases.
`--signed` requires `ADE_SIGNING_IDENTITY` and `ADE_NOTARY_PROFILE`; it signs
nested Mach-O files, verifies the app, submits to Apple, staples the result and
recreates the ZIP. It does not upload a public release. This path must be tested
with the project's own identity before a signed release can be claimed.

Repository ownership, project license and signing credentials are deferred by
the project owner. No top-level license has been selected on their behalf.
Native source licenses are retained in fetched dependencies. Their transitive
resource and provider notices need a reviewed release inventory; an upstream
MIT license does not by itself cover every shipped file.

## Required release verification

- Build and test from a clean checkout on the supported architecture.
- Launch the packaged app from a different directory with no source-tree paths.
- Exercise a conversation, terminal, browser, reconnect and restart.
- Verify all provider runtimes and required credentials are reported clearly.
- Check native interaction and accessibility on a physical Mac.
- Verify signing/notarization and Gatekeeper on a separate Mac.
- Review dependency notices, release symbols and migration compatibility.

The current CI definitions are configuration, not evidence of a hosted run.
Automatic updates and rollback require a separately chosen, authenticated
release channel. The development daemon restart controller is not an updater.

## Provider resource packaging

The initial package dereferenced every pnpm symlink. That copied a package again
at each dependency edge: the provider resources grew to approximately 3.76 GB of file content in the app. The root pnpm workspace now owns one lockfile. Packaging
deploys each provider's production graph into a self-contained staging tree,
then preserves relative links only after verifying that their resolved targets
remain inside that tree.
Absolute, escaping and broken dependency links fail packaging. Generated pnpm
Unix shims have their checkout-specific NODE_PATH rewritten relative to the shim.

The earlier independent-lockfile staging tree was approximately 1.15 GB. A
macOS arm64 shared-lockfile staging run on 26 September 2026 measured 2.0 GB
for both providers together. This increase needs a dependency-size audit before
distribution; no packages were removed speculatively.
Provider-owned test files, mock CLI/SDK fixtures and transient
caches are excluded. Third-party source, maps, types, licenses, assets and native
bindings are retained: OMP exports TypeScript source directly, and stripping its
source tree would break runtime imports. Both adapter package manifests contain
production dependencies, not a removable development dependency section.

Large retained resources include Claude's approximately 211 MiB native SDK
executable and OMP's approximately 160 MiB native binding. OMP also depends on
ONNX/audio packages with native libraries and browser assets. Some ONNX native
files target other operating systems. Those remain in this change; safe removal
needs a separately versioned, platform-aware policy and feature-level tests.
No native binding was removed to improve the size number.

Relocated staging validation passed the Claude bridge tests and OMP tests,
including its published CLI against a local model fixture and resumed history.
The Claude SDK imports from the relocated tree, and the relocated OMP command
shim runs. This validates packaging resolution, not every optional OMP feature.

## Remaining external runtimes

| Capability | Current requirement |
| --- | --- |
| App launch/recovery controller | `python3` on the GUI process PATH. There is currently no lux-ade-specific Python executable override. Contributor tooling requires Python 3.12+; runtime validation used Python 3.13.15. |
| Claude GUI | Node (`ADE_NODE_BIN` or `node`) plus a Claude CLI (`ADE_CLAUDE_BIN` or `claude`). The bridge explicitly requests that CLI even though the SDK package also contains a native executable. Adapter minimum is Node 18; current validation used Node 24.19.0. |
| OpenCode GUI | Node plus OpenCode CLI (`ADE_OPENCODE_BIN` or `opencode`). |
| OMP GUI | Bun (`ADE_BUN_BIN` or `bun`) plus packaged OMP dependencies. An optional `ADE_OMP_BIN` overrides its packaged CLI. The package declares Bun >=1.3.14; validation uses 1.4.2. |
| Codex GUI, default shared transport | Bun plus Codex CLI (`ADE_CODEX_BIN` or `codex`). Explicit stdio transport bypasses the Bun bridge. |

A Finder-launched app may inherit a different PATH from an interactive shell.
Installed runtimes therefore are not yet a self-contained end-user experience.

For a future self-contained distribution, bundle checksum-pinned Node and Bun
runtimes and resolve them by bundle path, then sign and validate their native
files. For Python, either bundle a complete standalone interpreter and standard
library or migrate the launch controller into Rust while preserving its existing
lifecycle tests. Prefer the Rust migration to avoid a third runtime. These are
options, not changes implemented by provider resource packaging.

## Rust notice inventory

Packaging runs `cargo metadata --locked --offline --format-version 1` with the
packaging host target and `ade-runtime/native-terminal`. It includes all workspace
members and records resolved features, dependency kinds and target predicates.
This deliberately includes build/dev dependencies; it is not a claim that every
listed crate is linked into the shipped executable. Cross-platform packaging is
not supported by this host-target selection.

`Contents/Resources/third-party/rust-dependency-inventory.json` records package
versions, registry/Git identities, available registry checksums and Cargo VCS
metadata, path-dependency archive/patch provenance, license declarations, and
retained notice hashes. `licenses/rust/` contains exact available notice bytes.
`RUST_DEPENDENCY_NOTICES.md` lists missing evidence. SPDX declarations are retained
as declarations: the tool neither generates substitute texts nor selects one
license from an `OR` expression. Texts can cover nested components, so even
`text-retained-unreviewed` is not clearance for distribution. Known vendor crates
also reference the separately retained native notice directory.

The inventory uses cached source and fails if offline Cargo resolution fails.
It does not download new dependencies or build native code. Developers must use
the same Rust environment that built the app. Source notices are copied only
within their package root; escaping symlinks are recorded as unresolved.

Local verification on 2026-09-25 resolved 578 packages, including five lux-ade crates,
and retained 928 notice files. 69 package entries lacked package-local notice
texts, including lux-ade's unlicensed workspace crates and two GPUI Kit crates whose
repository-root notices are retained by the native inventory. Missing evidence is
reported explicitly and remains distribution work. Registry crates such as
AccessKit and tree-sitter grammars still need their matching upstream texts.
Provider packages, embedded fonts, native linked dependencies and other resources
require separate completion; this Rust inventory does not close those gates.

## Installed provider notice inventory

Packaging inventories the copied provider tree using
`scripts/provider_notices.py`. It produces `provider-dependency-inventory.json`,
`PROVIDER_DEPENDENCY_NOTICES.md`, exact notice files under `licenses/providers/`,
and a copy of the root pnpm lockfile under `workspace-lockfile/`. It makes no
network calls and does not execute provider packages.

Each physical package directory has one entry; multiple pnpm symlinks become
aliases. Records include manifest hashes, name/version, declared license and
repository/source fields, notice hashes, and resolved edges for normal,
optional, peer and development dependencies. Source/integrity fields absent from
installed manifests remain absent; the copied, hashed lockfile retains pnpm's
resolution evidence without inventing a registry URL. The inventory does not
parse that lockfile or attest that local package content equals the registry
archive. `SEE LICENSE IN` files are retained when safely contained in the package.
Escaping or broken provider symlinks fail packaging; package-external notice
references are flagged rather than copied.

Scope covers every installed physical package, including optional/development
or stale packages present on disk. It is not a production reachability analysis.
Missing optional/peer/development edges can be expected on a production or
platform-specific install and remain explicit unresolved edges. Missing normal
dependency edges also produce a review issue. No SPDX alternatives are selected,
and retained texts remain unreviewed for compatibility and nested attribution.

Local validation on 2026-09-25 inventoried 233 package/root entries, retained 232
notice files and reported 13 entries with unresolved evidence; no required
normal-dependency edges were missing. Fixture tests cover alias deduplication,
edge resolution, missing declarations/text, custom license-file references, and
escaping/broken symlinks. Native linked dependencies, embedded fonts and other
resources still need their separate distribution review. External Node, Bun,
Python and provider CLI prerequisites are outside this installed-package inventory.

## Native and resource evidence inventory

Packaging also emits `native-resource-inventory.json` and
`NATIVE_RESOURCE_NOTICES.md` through `scripts/native_notices.py`. The inventory
hashes actual copied Ghostty resources, terminfo, lux-ade assets and terminal config.
It records matching source paths where bytes match and preserves license-related
header evidence. It hashes configured Ghostty parser/renderer archives and lists
archive members using `ar -t`. These are build inputs, not a linker map: archive
membership does not prove which objects or libraries entered each executable.

The collector retains Ghostty's root/nested `build.zig.zon` manifests and source
files that declare embedded fonts. It follows literal URL/hash dependency
records into cached Zig package archives, retaining their available notice texts,
nested manifests and font-file hashes. It includes lazy/platform/test candidates;
cache presence never implies linkage. Raw manifests remain authoritative because
the collector is not a Zig parser or build-graph evaluator. Cached archives are
matched by Zig package-hash filenames and receive a separate SHA-256 record; the
collector does not recompute Zig package hashes or attest origin. Unsafe archive
paths are rejected, archive links are not followed, and no archive is extracted.
Missing cache evidence is recorded rather than downloaded.

The default cache is `$ZIG_GLOBAL_CACHE_DIR/p`, or `~/.cache/zig/p` when unset.
This supports Zig 0.16's cached `.tar.gz` package layout used by the pinned build.
A different cache layout requires adaptation and will otherwise report missing
evidence. The collector also inventories the GPUI Kit SVG catalog embedded by
lux-ade's `AllAssets`, retaining its Lucide ISC notice and build/source evidence. GPUI
Kit story/demo fonts are not asserted to ship merely because the source tree
contains them.

Local inspection on 2026-09-25 found 619 loose resource files and 1,830 SVG icon
source files. Renderer/parser archives contained 277/13 member records. Retained
Zig manifests identified 38 dependency candidates, with 26 archives available in
the local cache and 71 notice texts retained. Tests cover exact notice retention,
font hashes, nested manifest discovery, missing cache evidence, traversal
rejection, resource headers/hashes and escaping resource symlinks.

The bounded inventory is complete; distribution clearance remains open:

- The theme archive omits a license file. A pinned supplement now retains the
  upstream MIT notice after matching all 607 cached files to the same revision.
  Packaging applies this evidence only to the recorded archive hash.
- JetBrains Mono's cached OFL/authors texts are retained. Nerd Fonts' root MIT
  text and available pinned upstream glyph notices are retained; the complete
  composite glyph attribution set and embedded-glyph mapping remain unresolved.
- Ghostty shell integration includes GPL headers. The three corresponding
  shipped scripts are now mapped to the retained full GNU GPLv3 text. Attribution,
  source obligations, and distribution review remain open.
- Establish exact static/native linkage and per-component attribution using build
  output or a link map. Do not infer libintl or another optional dependency is
  linked solely from a cached package or the historical libghostty-spm notice.
- lux-ade assets still have no chosen project license. Provider-native binaries and
  downloaded runtime libraries remain within the separate provider review, not
  automatically covered by the Ghostty source MIT license.

Unsigned archive transport has a macOS fixture test in `test_bootstrap.py`. It
uses release.sh's `ditto` ZIP/extraction options and checks relocated pnpm links,
all four inventory filenames, executable bytes, executable/dSYM UUID pairing,
DWARF hash and execution of the extracted fixture. This complements symbol and
inventory tests; it does not constitute a signed full-app or clean-machine test.
