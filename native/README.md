> The legacy commands below describe the original prototype build. The current
> reproducible entry point is `python3 scripts/bootstrap.py`; see
> [build and release](../docs/build-and-release.md). The manifest pins the same
> source, and `patches/ghostty.patch` supersedes the historical `native/ghostty-snapshot.patch` (which also contains
> font-cache and GPU timing changes). See the [patch ledger](../docs/vendor-patches.md).
> Current build defaults are project-local `.ade/` paths, not `work/` paths.

# Native terminal feasibility boundary

This prototype embeds Ghostty's Metal renderer in a real AppKit `NSView` hosted
by GPUI. The surface runs the prototype's attach command. The daemon retains the
actual shell PTY after a surface/window closes.

`crates/ade-platform/native/terminal.m` is original integration code using Ghostty's published embedding
header, with Ghostex's native surface ownership design as reference. It does not
load the user's Ghostty configuration. Input includes native keys, text input and
IME composition, selection/mouse input, scrolling, and text clipboard callbacks.
IME and international keyboard layouts require interactive validation before
claiming full parity. App activation, window key changes and occlusion changes
update surface focus/visibility through AppKit notifications. The runtime app is process-global and intentionally
lives until process exit; each terminal surface has deterministic teardown.

## Pinned source and native extension

Both native renderer and daemon parser use Ghostty source vendored by Herdr at
`9c96f7ddb3be2cc575a159d4d1f1d49fb10d7006`. The reference checkout and
`work/vendor/libghostty-vt` remain unchanged. The native build uses an isolated
copy at `work/build-native/ghostty` with `ghostty-snapshot.patch` applied.
This is a local extension, not a published upstream embedding API.

The patch adds three main-thread APIs:

```c
bool ghostty_surface_restore_snapshot(ghostty_surface_t, const uint8_t*, size_t);
bool ghostty_surface_feed_output(ghostty_surface_t, const uint8_t*, size_t);
bool ghostty_surface_resize_terminal(ghostty_surface_t, uint16_t, uint16_t);
```

Restore validates a complete binary snapshot before replacing the live terminal.
It releases tracked selection pins, preedit, parser state and terminal pages
under the renderer mutex, keeps the terminal object's address stable, restores
unfinished input once and invalidates the renderer. Native search/inspector
sessions must be absent during restoration.

After restore, subprocess stdout cannot mutate the parser. The host feeds only
ordered daemon output after the snapshot cut. `ade-attach --input-only` forwards
keyboard input and geometry. Local view resize updates pixels and the attach PTY;
only ordered daemon resize events reflow the terminal grid. Every output/resize
event carries a byte offset; a gap triggers reconnect, not silent corruption.

The version-pinned format is `ghostty-snapshot-v1-herdr-9c96f7d`. Ghostty labels its
snapshot format experimental. Do not mix independently upgraded parser/renderer
builds. Caps: native snapshot 64 MiB, continuation 1 MiB, feed call 4 MiB,
terminal dimensions 2..1000. The Rust transport additionally limits each encoded
message to 32 MiB. The daemon caps binary snapshots at 8,257,536 bytes to
reserve worst-case decimal-array expansion and escaped metadata; oversize
snapshots fail explicitly. The native 64 MiB ceiling is not reachable through
this transport. Snapshot JSON arrays are a prototype transport choice.

External native StreamHandler instances now discard automatic PTY writes,
query reports and programmatic clipboard effects. Termio also suppresses automatic
focus/color/visibility/size reports. Genuine key, text, user paste, mouse and copy
actions use their independent input paths and remain enabled. The daemon owns
query replies; this is still not an untrusted-remote snapshot security boundary.

Build from the isolated source using Zig 0.16.0 and Xcode with Metal Toolchain:

```sh
# Start with a copy of work/vendor/libghostty-vt in work/build-native/ghostty.
# Apply this patch there with git apply /absolute/path/to/ghostty-snapshot.patch.
# Replace <task> with the task root; run inside work/build-native/ghostty.
mkdir -p macos
<task>/work/toolchains/zig-0.16.0/zig build \
  -Dapp-runtime=none -Demit-xcframework=true -Dxcframework-target=native \
  -Demit-macos-app=false -Doptimize=ReleaseFast -Dstrip=false -Demit-docs=false \
  -Demit-helpgen=false -Di18n=false \
  --global-cache-dir <task>/work/zig-global-cache \
  --prefix <task>/work/build-native/install
```

Herdr's source omits the translations, so i18n is disabled. The native archive is
`work/build-native/ghostty/macos/GhosttyKit.xcframework/macos-arm64/libghostty-internal.a`,
with its matching `Headers/ghostty.h`. Resources are under
`work/build-native/install/share/ghostty`. `build.rs` uses those defaults;
`GHOSTTY_KIT_DIR` and `GHOSTTY_RESOURCES_DIR` can override them.

Verified archive SHA-256:
`aab6c370c8a14bba179f7d1fe69a21b6683bd559e9e0d2ccacf278b42e687f77`.

Apple's `xcodebuild -downloadComponent MetalToolchain -exportPath ...` downloaded
and activated the compiler through its system-managed cache before exporting it.
It was not a workspace-only installation. No Xcode selection was changed.

Ghostty source is MIT; bundled dependencies/resources have their own licenses.
Adjacent notices from the previous sethdeckard/libghostty-spm v0.2.0 experiment
are retained as historical provenance, not a complete manifest for this new
source build. Distribution requires a dependency/license manifest for this build.
The old binary remains in `work/ghostty-kit` but is no longer linked.

Only the Objective-C boundary includes `ghostty.h`; Rust does not duplicate its
evolving structs. This development bundle still depends on absolute task-local
resource paths and is not a standalone distributable.

## Child panel overlay seam

`NativeChildWindow::attach(parent_nsview, popup_nsview)` attaches a separate
GPUI popup's AppKit window above its workspace. Keep the returned value in the
popup's root entity. Its Drop detaches; the caller still owns the GPUI window.
The browser and terminal remain live and visible around the panel. AppKit
handles composition above both child views, so this does not try to paint a
same-window GPUI element over a native view.

The relationship centers the panel initially and after parent resize. AppKit
moves child windows with their parent. Parent close hides/detaches the panel and
queues its native close; GPUI's macOS `-close` override forwards that to its
window registry. Explicit Close must still call GPUI's window removal path.
The child uses its parent's window level and hides when the app deactivates.

Use ordinary `WindowKind::PopUp` or `Dialog`. Although the pinned GPUI exposes
`AnchoredPopup`, its macOS platform rejects that variant. This seam uses the
existing AppKit `addChildWindow:ordered:` API and requires no extra dependency.
It does not implement modal input blocking, outside-click dismissal, arbitrary
popover anchors, or a whole-app overlay compositor. Runtime interaction testing
is needed before treating this composition seam as production-ready.

## Headless daemon parser

The daemon uses libghostty-vt copied unchanged from Herdr's vendored source at
commit `9c96f7ddb3be2cc575a159d4d1f1d49fb10d7006`. The original reference checkout
is unchanged. The isolated source is in `work/vendor/libghostty-vt` and retains
its MIT license (Mitchell Hashimoto and Ghostty contributors).

Zig 0.16.0 was downloaded from the official aarch64 macOS distribution. Its
SHA-256 was verified against official download metadata:
`b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489`.
The toolchain lives in `work/toolchains/zig-0.16.0`.

Build from the isolated source directory, replacing `<task>` with this task root:

```sh
<task>/work/toolchains/zig-0.16.0/zig build \
  -Demit-lib-vt -Doptimize=ReleaseFast -Demit-xcframework=false \
  --cache-dir <task>/work/zig-cache \
  --global-cache-dir <task>/work/zig-global-cache \
  --prefix <task>/work/libghostty-vt
```

`build.rs` compiles `src/terminal_state.c` against those exact C headers and links
`work/libghostty-vt/lib/libghostty-vt.a` only into `ade-daemon`. The GUI renderer
archive links only into `ade-client`. Both use the same underlying terminal
source. The daemon enables 4 MiB history and 1 MiB continuation tracking before
accepting output. Binary snapshot registration and live subscription share its
state lock, so output cannot fall between them. ANSI formatting remains only for
JSON diagnostics; interactive outer-terminal output is disabled.

The native surface smoke test passed both buffers, partial ANSI/UTF-8/OSC,
transactional rejection, local-versus-authoritative resize, renderer ticks and
teardown. The full application also visibly restored detached output and returned
to the preserved primary shell. The client's `--ui-smoke` verifies parent/panel
cleanup while another workspace survives.

## GPU timing instrumentation

`ADE_GPU_BENCH_LOG` enables a bounded histogram in Metal command-buffer completion
callbacks. It records `GPUEndTime - GPUStartTime`, valid/invalid/error counts,
0.01 ms percentile upper bounds and exact maximum. It writes at most once per
second and flushes on normal exit. Forced termination can omit the final samples;
readers retry transient partial JSON writes. Ordinary builds do no sampling or
file IO without that environment variable.

This measures Ghostty GPU execution, not total application frame time, queue
wait, presentation latency or input-to-photon latency. The native ownership smoke
still passes with this instrumentation enabled. Apple documents the timestamps
at https://developer.apple.com/documentation/metal/mtlcommandbuffer/gpustarttime
and https://developer.apple.com/documentation/metal/mtlcommandbuffer/gpuendtime.


## Font-cache contention fix

The ten-viewer profile identified `SharedGrid.getIndex` and `renderGlyph` as the
largest active stacks. Even shared read locks update the same atomic lock state
for every character/glyph across renderer threads. The lux-ade patch adds a bounded
thread-local copy of successful lookups: 256 codepoint entries and 256 glyph
entries. Cache misses retain the original synchronized lookup, font loading and
atlas mutation path. It does not suppress rendering, lower frame rates, change
fonts or discard output.

Each SharedGrid receives a unique lifetime ID, so address reuse and font/grid
replacement cannot return an old entry. Keys match the shared caches, including
style, presentation and glyph options. Negative codepoint results may be cached;
errors are never cached. Entries contain copied values, not pointers into atlas
storage. Atlas growth preserves glyph coordinates; texture synchronization keeps
its existing lock. TLS storage is fixed-size and reclaimed with its thread.

The focused native tests cover lifetime/address reuse, key collisions, styles,
missing characters, cached versus shared results and atlas growth. All 85 tests
selected by `zig build test -Dtest-filter=font.SharedGrid` passed. The vendor copy
omitted the GLAD files required by Ghostty's test build; the exact upstream
revision and hashes used to restore those test-only inputs are in
`work/build-native/BUILD.md`. Production library builds do not use them.

The release CPU regression is `scripts/test_render_scaling.py`. It creates ten
real viewers and sustained PTY output, checks that output is still consumed,
and fails above two CPU cores on this Mac. This is a guard against the observed
six-core regression, not a cross-machine product budget. The same test failed
with the previous archive linked and passed again after restoring the fix.
`-Dstrip=false` retains native function symbols for future sampling; optimization
remains ReleaseFast.
