# 15 — Import Warp terminal themes

Status: in-progress
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Import Warp YAML into the same terminal library and preview workflow used by other theme sources.

**Blocked by:** [09 — Manage custom themes and ADE import/export](09-ade-theme-library.md)

**Spec coverage:** TH21. User stories 49, 56. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Parse supported Warp terminal colors into normalized values with source-located errors and visible unsupported-key diagnostics.
- [x] Preview, naming, conflict handling, provenance and explicit install reuse the common library; no second theme store or mode preference is introduced.
- [x] The selected imported theme reaches native defaults and WASM views through the existing binding rules and survives restart.
- [x] Malformed/oversized YAML and canceled imports leave committed definitions unchanged; imports never modify the source file or unrelated appearance preferences.
- [x] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Prove YAML normalization and failure cases through public import operations, then import/select a fixture in the desktop and compare terminal colors with the normalized result.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.

## Comments

### 2026-09-30 — Warp YAML import, conflict replacement and terminal rendering

The Warp importer uses the common theme validator, library and revision-checked installer. The desktop flow previews a local terminal sample, requires explicit acceptance, shows an existing revision before replacement, preserves source attribution and leaves appearance unchanged until the user selects the imported ID. A later binding to the imported theme resolves its ANSI colors through the native appearance response and the WASM terminal canvas. The selection remains after a daemon restart. Warp's omitted-cursor rule now maps a valid accent to cursor color while still warning that the accent's Warp UI effects are unsupported. Common-validation errors point at their YAML scalar, and diagnostics count LF, CRLF and standalone CR with Unicode-scalar columns.

Evidence:

- `pnpm test:e2e:desktop:only e2e/desktop/warp-theme.spec.ts --workers 1`: **4 passed** (`test-results/runs/desktop-d1a38a49-872b-4138-89c5-f89b3ccf9d1c`). This exercises cancellation, malformed and oversized input, source preservation, preview, explicit install, duplicate-ID replacement, unchanged appearance, selected ANSI green rendered by the WASM terminal, and fixed binding/palette persistence after daemon restart. Inspected [`warp-theme-preview.png`](../../../../../test-results/runs/desktop-d1a38a49-872b-4138-89c5-f89b3ccf9d1c/artifacts/warp-theme-desktop-preview-a2260-without-selecting-the-theme/warp-theme-preview.png); the preview, diagnostics and acceptance control are visible and legible.
- `pnpm test:e2e:protocol:only e2e/protocol/profiles/ghostty-theme.spec.ts`: **7 passed** (`test-results/runs/protocol-59f8b262-82f2-40bb-b87c-34bf19eafee3`), including valid Warp normalization/CLI parity, malformed and duplicate keys, oversized input, invalid CLI status 2, bounded Warp file reads and read-only failure cases.
- `node scripts/cargo.mjs test -p ade-daemon warp::tests --lib`: **5 passed**, covering accent fallback, blank-name and newline source locations, malformed/duplicate YAML and the source-size limit.
- `pnpm check:static`: **passed** (`test-results/runs/static-51275be3-eb2e-4247-a26d-b224987c09f8`), including formatting, generated contracts, API parity, builds, type checks, lint, renderer/provider tests, Clippy, test discovery, legacy Rust tests and doctests. The final run passed in 59 seconds. One earlier run hit the existing sidebar-width assertion at 259.984375 px versus 260 px; the isolated assertion and subsequent full gates passed.
- Rust test output includes a non-fatal `rust-objcopy` warning because this machine lacks `libLLVM.dylib`. Static test support also reported one retained temporary runtime directory; neither prevented the successful final gate.

Ticket 15 remains in progress because its declared prerequisite, ticket 09, remains open in the 09 → 08 → 07 production-consumer chain. `pnpm test:acceptance` was not run; aggregate TH21 remains unverified until that chain is resolved.
