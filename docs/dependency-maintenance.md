# Dependency maintenance

Historical scan and GPUI dependency analysis from 2026-09-25. The package paths below may no
longer be in the current Cargo graph. Re-run `scripts/check_dependencies.sh` against the current
lockfile before using an advisory count or migration route. The native-client seam table below
describes the removed GPUI app.

The 2026-09-25 cargo-deny scan covered the complete workspace dependency graph,
including platform-specific and development dependencies. It found seven
unmaintained-package advisories and no vulnerability, unsoundness, or yanked
package failures. Source and bans checks passed; duplicate dependency versions
remain warnings. This is a point-in-time scan, not a guarantee about future
advisories or all code paths.

Maintenance advisories stay visible as warnings through the explicit
`--warn unmaintained` argument in `scripts/check_dependencies.sh`. Vulnerability,
unsoundness, yanked-package and unknown-source failures continue to block. There
are no ignored advisory IDs. Re-run the script before releases; it updates the
RustSec database rather than pinning stale vulnerability data.

| Package | Advisory | Verified route into lux-ade | Replacement work to track |
| --- | --- | --- | --- |
| fxhash 0.2.1 | [RUSTSEC-2025-0057](https://rustsec.org/advisories/RUSTSEC-2025-0057) | lb-wry → kuchikiki → selectors | Follow a maintained selectors/HTML parsing update in lb-wry; upstream recommends rustc-hash. |
| instant 0.1.13 | [RUSTSEC-2024-0384](https://rustsec.org/advisories/RUSTSEC-2024-0384) | gpui-base, gpui-component; also notify → notify-types | Migrate native clocks to std::time where suitable and browser clocks to web-time through GPUI Kit updates. |
| paste 1.0.15 | [RUSTSEC-2024-0436](https://rustsec.org/advisories/RUSTSEC-2024-0436) | gpui-component and metal/core-video paths | Follow macro replacement in GPUI Kit and metal bindings; upstream lists pastey and with_builtin_macros. |
| proc-macro-error 1.0.4 | [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370) | lb-wry → GTK/glib → glib-macros on Linux | Upgrade the webview GTK dependency family together before Linux desktop support. |
| rustls-pemfile 2.2.0 | [RUSTSEC-2025-0134](https://rustsec.org/advisories/RUSTSEC-2025-0134) | gpui-kit-assets → gpui-pre-reqwest | Follow the reqwest fork migration to rustls-pki-types PEM APIs. |
| rustybuzz 0.20.1 | [RUSTSEC-2026-0206](https://rustsec.org/advisories/RUSTSEC-2026-0206) | gpui-component/resvg and gpui-pre → usvg | Upgrade SVG/text shaping consumers to a maintained shaping stack; upstream recommends harfrust. |
| ttf-parser 0.25.1 | [RUSTSEC-2026-0192](https://rustsec.org/advisories/RUSTSEC-2026-0192) | usvg/rustybuzz/fontdb, including GPUI's other-platform text backend | Coordinate font parsing and shaping changes; upstream recommends skrifa. |

These are upstream migration tasks, not safe patch-version bumps. No package
was replaced solely to silence a check. Any migration needs rendering, text,
font, native integration and performance validation appropriate to its scope.

License approval is separate. The current checks explicitly exclude the license
check pending a distribution policy; see `THIRD_PARTY_NOTICES.md` for what the
existing notice inventory does and does not cover.

## Conditional runtime and native binding decisions

Reviewed against lux-ade's current seams on 2026-09-25. No dependencies are added by
this review. These decisions must be revisited when a seam changes materially.

| Seam | Current implementation and decision | What would justify changing it |
| --- | --- | --- |
| Terminal NSView, input/IME, renderer callbacks | Keep `ade-platform/src/terminal.rs` over ARC-compiled `native/terminal.m` and Ghostty's C ABI. The Rust handle owns detachment while the supervisor owns the process. | A demonstrated ownership/threading defect or new native API that benefits from typed objc2 ownership; preserve native input, snapshot and close tests during any port. |
| Native child popup/window attachment | Keep `NativeChildWindow` in the same platform seam. Its Drop detaches a child without owning the GPUI window itself. | A focused migration can express the existing main-thread and retained-object guarantees without changing lifecycle behavior. |
| Native accessibility bridge | Keep `native/accessibility.m`, with its dedicated native test harness. It bridges GPUI and attached AppKit views and uses Objective-C runtime method dispatch. | A port must prove dynamic subclass/dispatch correctness, child enumeration and focus exposure; adding objc2 alone does not prove these. |
| Browser WKWebView | Keep GPUI Kit/Wry's existing WebView ownership in `ade-client/src/native_panels.rs`; avoid adding a second direct WKWebView wrapper. | An API requirement or bug unavailable through the maintained wrapper, with browser focus/navigation/close validation. |
| GPUI menus/windows/platform callbacks | Keep the pinned GPUI macOS implementation and reviewed callback patch. lux-ade does not own this entire upstream seam. | Prefer an upstream fix/upgrade; a direct objc2 fork would increase maintenance and needs a separately scoped compatibility test. |
| Daemon/runtime socket and process workers | Keep current explicit worker ownership, bounds/deadlines and shutdown protocol. No direct Tokio runtime is added to lux-ade today. | Measured connection/thread scaling or a cancellation/ownership problem that becomes simpler with one scoped reactor and explicit shutdown supervision. |
| Client background work | Keep GPUI's executor, owned tasks and bounded async channels. | A concrete operation cannot satisfy cancellation/deadline requirements within this arrangement; do not start a second scheduler for UI tasks by default. |

The objc2 API provides `MainThreadMarker` and typed retained ownership, useful
building blocks for a future focused port; it does not remove the need to prove
our FFI contracts. See [objc2](https://docs.rs/objc2/latest/objc2/) and
[MainThreadMarker](https://docs.rs/objc2/latest/objc2/struct.MainThreadMarker.html).
Tokio's [shutdown guidance](https://tokio.rs/tokio/topics/shutdown) separates
triggering cancellation, notifying tasks and waiting for completion. Any adoption
must define all three and preserve lux-ade's supervisor/process ownership. The
presence of Tokio/objc2 transitively in Cargo.lock is not a decision to add a
second direct integration.

Searches for official agent-specific guidance did not establish a special lux-ade
integration skill or MCP workflow for these seams. Ordinary official API docs
are the basis of this evaluation; absence from search results is not a claim
that upstream has no contributor guidance. No Tokio/objc2 implementation was
written against unverified agent instructions.
