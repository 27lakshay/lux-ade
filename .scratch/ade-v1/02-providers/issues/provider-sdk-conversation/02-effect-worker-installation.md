# 02 — Install and inspect an Effect provider worker

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Install a separately packaged Effect worker through the normal plugin path and inspect its validated identity, capabilities, version compatibility and readiness through public operations and desktop controls.

**Blocked by:** None — can start immediately

**Spec coverage:** PC01, PC03, PC20, PC36, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Resolve the latest Effect v4 RC at implementation start, record exact compatible pins and read its shipped agent guidance. Confirm SDK-scoped diagnostics against ADE’s pinned TypeScript/Oxlint tools; do not silently patch a shared compiler.
- [x] Rust-owned declarations generate worker wire types and validators. The descriptor, capability support/availability, operation tiers and typed failures have one authority, with malformed or incompatible fixtures rejected consistently.
- [x] The framework-neutral ESM provider SDK supports a scoped descriptor/factory and minimal discovery path over the existing worker transport. Protocol framing stays on stdout; bounded sanitized diagnostics stay on stderr.
- [x] A normally installed diagnostic worker can be inspected through CLI/SDK and the desktop without launching native work. This proves installation mechanics, not the real additional-provider requirement owned by ticket 21.
- [x] One managed runtime owns the worker instance. Acquisition, cleanup and generation fencing prevent leaked resources and late callbacks; output, RPC concurrency and frames have declared byte/entry bounds.
- [x] Any offered Promise convenience shares the same implementation and scope. Wire versions, declared package requirements and install/readiness errors remain explicit.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Exercise the installed artifact through real daemon/runtime processes, compare visible readiness, and run focused generated-schema/codec equivalence tests. Begin reusable conformance support here without a second supervisor.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-01: Ticket 02 accepted by Main after the integrated static gate, final provider protocol run, and built-desktop provider-only run. All seven acceptance criteria above are accepted. The ticket status remains `ready-for-agent`.

**Effect toolchain and diagnostics.** `effect` and `@effect/platform-node` are pinned to `4.0.0-rc.118`; `@effect/tsgo` is `0.47.1`, TypeScript is `7.0.2`, Oxlint is `1.85.0`, and `oxlint-tsgolint` is `7.0.2003`. The shipped Effect agent guidance was read. The TypeScript-native LSP reports `OK` for `packages/provider-sdk/src/node.ts`; the SDK build and final static gate passed. The malformed/incompatible descriptor regression passed 1/1 with `node scripts/cargo.mjs test --locked -p ade-runtime malformed_and_incompatible_descriptors_fail_closed`.

**Final static gate.** `pnpm check:static` passed with exit 0: format, static analysis, API/contract/architecture/lint/deadcode checks, SDK build, workspace and E2E typechecks, browser (52 files/418 tests), renderer, clippy, discovery, Rust tests, and Rust docs. Report: `test-results/runs/static-994819cb-4595-4e16-92e5-bbac63f51467`. Rust reports 885 passed and 1 skipped. The only skipped case is `ade-daemon::store::tests::creation_interruption_child`, with JUnit reason `Skipped: test does not match the run-ignored option`; this is an ignored child test, not a native-prerequisite skip.

**EOF output before and after.** Before the fix, ending stdin after three admitted large initialize requests while stdout was paused produced only `init-1` (about 656,456 output bytes) and exited 0. The permanent regression failed before the fix with `Provider SDK worker ended before a response` (report `test-results/runs/protocol-a3d56abb-505b-412b-be0a-e1743e21633c`). With the minimal immediate EOF fence/interruption, output-queue end, and bounded writer join, the regression passes with replies for IDs 6, 7, and 8, protocol version 1, no `EPIPE`, and one factory release.

**Provider protocol and cleanup.** `pnpm test:e2e:protocol:only e2e/protocol/plugins/provider-sdk.spec.ts` passed both cases against the final implementation (report `test-results/runs/protocol-741478f0-b2d5-4ac2-8e71-badca94f0efe`). A held-send EOF smoke exited 0, released the factory once, and produced no unhandled error. A small EPIPE smoke exited 1 with typed `transport_failure`, released once, and produced no unhandled error. These two cleanup/EPIPE checks are inline smoke evidence, not separate permanent tests.

**Built desktop and acceptance scope.** The final provider-only built-desktop run passed 1/1 in 13.9s with no failures, skips, or unexecuted cases (report `test-results/runs/desktop-28f71a30-b857-4fac-928b-9e62c8dbc917`). Readiness was exercised and SDK/CLI identity matched. Native work was deliberately skipped and native provider-call ledgers stayed empty. This verifies installation and readiness only; ticket 21 owns the real additional-provider native requirement.
2026-10-02: Status set to `complete` to match the recorded acceptance above. No new verification was run.
