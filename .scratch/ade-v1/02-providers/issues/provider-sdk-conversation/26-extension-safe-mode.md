# 26 — Recover from thrown and frozen UI extensions

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Recover a usable conversation after an extension throws or freezes, with retained history, requests, drafts and Stop available.

**Blocked by:** [04 — Answer native approvals and structured questions](04-native-requests.md), [05 — Stop an identified execution truthfully](05-identified-stop.md), [24 — Render namespaced timeline content with a core fallback](24-timeline-contributions.md), [25 — Extend the composer without losing recoverable input](25-composer-contributions.md)

**Spec coverage:** PC12, PC13, PC22, PC24, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Thrown timeline/composer errors remain local and show core-readable fallback; a failed custom request form leaves core-supported actions available.
- [x] A frozen renderer follows Electron’s recovery path into a fresh plugin-disabled renderer rather than relying on a watchdog inside the blocked renderer.
- [x] Recover pending requests, durable draft/send identity and unknown outcomes from authoritative state; recovery does not re-answer or resend automatically.
- [x] Stop and supported reconciliation remain available in safe mode. Renderer recovery does not terminate runtime-owned work implicitly.
- [x] Display which contributions are disabled and preserve usable diagnostics without leaking native private data or widening unknown request permissions.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Throw and deliberately freeze installed UI contributions in built Electron against scratch real backends; verify recovery, request identity, draft retention and reachable Stop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Built; status left for review. A thrown timeline renderer stays inside its message's error boundary; a throwing or invalid composer transform is skipped with a note. A hung renderer is recovered by main's existing `renderer-recovery.ts` (unresponsive, forced crash, reload with `?safeMode=1`). Safe mode loads no plugin UI, lists the plugins whose UI is off with their contributions, and offers "Continue in safe mode" so the workspace stays usable without plugins. The draft, pending request and send identity come back from main and daemon state; nothing is re-answered or resent, the runtime turn keeps running, and Stop works. Evidence: `e2e/desktop/plugin-ui.spec.ts`, "a plugin that hangs the renderer…". Limit: Chromium reports no hang while a debugger is attached, and Playwright attaches one, so the test confirms from main that the renderer is hung and then emits the window's `unresponsive` event itself. Playwright keeps its page marked crashed, so the test drives the recovered renderer through main. The class 6 gap in the protocol fault suite now names this desktop test.

2026-10-02: Accepted after review and integration (decisions taken under the user's standing instruction to decide unattended).

The implementation above was built in an isolated worktree, reviewed, and applied to agent-work-2 together with the parallel work on tickets 20, 21 and 24–26 (conflicts in the workspace list, provider test runner and provider README merged by hand; generated contracts and the lockfile regenerated here, not copied). On the merged tree: `pnpm check:static` passed (`test-results/runs/static-e687aa37-a5b5-4dd7-b805-3de4575087b5`); `e2e/protocol/adapters` 24 passed with 3 opt-in live cases skipped, and `plugins/ui-contributions.spec.ts` passed; built Electron `acp.spec.ts`, `plugin-ui.spec.ts` and `opencode-plugin.spec.ts` 7/7.
Full runs on the merged tree: protocol 1097 passed, 6 failed, 8 skipped; the six also fail on HEAD (conversation delete after a daemon kill, lost turn, theme validation and three escaped-descendant cases). Desktop 118 passed; the `plugin-ui.spec.ts` cases failing in that run were caused by a fixture change made mid-run and pass 6/6 on the rebuilt tree (`test-results/runs/desktop-ea7ff3c7-a195-4965-b213-b4e50094c7b9`), with `appearance.spec.ts` density passing on rerun.

Accepted as built. The freeze test emits the window's `unresponsive` event itself after confirming from main that the renderer is hung, because Chromium does not report a hung page while Playwright's debugger is attached; everything after that event is production code.
