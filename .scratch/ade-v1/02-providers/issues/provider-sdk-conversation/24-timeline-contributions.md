# 24 — Render namespaced timeline content with a core fallback

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Install a typed timeline contribution and declared actions while preserving canonical readable history when its renderer is missing or fails.

**Blocked by:** [23 — Preserve active work across plugin lifecycle changes](23-plugin-leased-executions.md)

**Spec coverage:** PC02, PC03, PC22, PC29, PC33. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Separate backend and UI entry points. The provider SDK remains React/Electron-independent and headless installation never loads UI modules.
- [x] Namespaced events/actions declare IDs, versions, schemas, tiers, limits and core summaries. Validate extension invocation through existing application admission.
- [x] Load timeline renderers through the production activation-owned registry, using existing command and resource-link conventions rather than a second plugin lifecycle.
- [x] Retain stable canonical content and blob provenance independently of render transforms. Large custom payloads remain bounded and core-readable.
- [x] Missing or throwing renderers fall back locally without hiding tools, files/diffs or retained data; departing registration cleanup cannot remove an updated contribution.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Install a real contribution against deterministic provider events, invoke actions through public contracts and verify normal/missing/thrown rendering and headless operation.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Built; status left for review. Manifests declare `contributes.timeline` (`id`, `version`, `item_kind`, `title`; plugin-prefixed, bounded, ui entry required). The daemon validates them and records `timeline` activation registrations, visible in `plugin.inspect` and `plugin.list`. Provider items may carry a namespaced `kind` and `content: {type: "extension", data}` of at most 64 KiB; an oversized payload is dropped when stored and the canonical `text` stays. Electron main serves only the current enabled generation's files on `ade-plugin://<id>/<generation>/`. `renderer/src/plugins/ui-host.ts` is the single activation-owned registry: declared IDs only, cleanup by generation. A missing, loading, disabled or throwing renderer shows the canonical text with "Custom view unavailable: <reason>" inside an error boundary. Evidence: `e2e/desktop/plugin-ui.spec.ts` (custom view, disabled fallback, thrown fallback with Stop), `e2e/protocol/plugins/ui-contributions.spec.ts` (declaration, headless provider, refusals), daemon manifest tests, `ui-host.test.ts`. Not built: declared timeline actions (they would go through `plugin.command.invoke`) and payload schemas beyond `version`.

2026-10-02: Accepted after review and integration (decisions taken under the user's standing instruction to decide unattended).

The implementation above was built in an isolated worktree, reviewed, and applied to agent-work-2 together with the parallel work on tickets 20, 21 and 24–26 (conflicts in the workspace list, provider test runner and provider README merged by hand; generated contracts and the lockfile regenerated here, not copied). On the merged tree: `pnpm check:static` passed (`test-results/runs/static-e687aa37-a5b5-4dd7-b805-3de4575087b5`); `e2e/protocol/adapters` 24 passed with 3 opt-in live cases skipped, and `plugins/ui-contributions.spec.ts` passed; built Electron `acp.spec.ts`, `plugin-ui.spec.ts` and `opencode-plugin.spec.ts` 7/7.
Full runs on the merged tree: protocol 1097 passed, 6 failed, 8 skipped; the six also fail on HEAD (conversation delete after a daemon kill, lost turn, theme validation and three escaped-descendant cases). Desktop 118 passed; the `plugin-ui.spec.ts` cases failing in that run were caused by a fixture change made mid-run and pass 6/6 on the rebuilt tree (`test-results/runs/desktop-ea7ff3c7-a195-4965-b213-b4e50094c7b9`), with `appearance.spec.ts` density passing on rerun.

Added during review: declared timeline actions and required payload fields, which the criteria ask for and the first build left out. A timeline contribution may declare `actions` (a title plus a command this plugin declares; validated by the daemon, at most four) and `required_fields`. Actions show beside the custom view and beside the canonical-text fallback, and run through `plugin.command.invoke` with `{conversation_id, message_id}`; a payload without a required field is not handed to the renderer, and the fallback names the missing field. Evidence: daemon test `timeline_actions_name_declared_commands_and_required_fields_are_bounded`; `e2e/desktop/plugin-ui.spec.ts` (the "Recheck" action completes through the fixture backend command; a `partial` payload falls back with "the payload lacks passed" and keeps its actions). The UI fixture gained a backend entry with that command and its `out_dir` setting.
