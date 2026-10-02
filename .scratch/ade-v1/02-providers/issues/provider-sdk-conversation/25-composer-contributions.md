# 25 — Extend the composer without losing recoverable input

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Install a composer contribution that prepares validated input before admission and preserves readable drafts after disable or upgrade.

**Blocked by:** [15 — Preserve composer drafts, recall and stash](15-recoverable-drafts.md), [23 — Preserve active work across plugin lifecycle changes](23-plugin-leased-executions.md)

**Spec coverage:** PC02, PC24, PC25, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Declare contribution schemas and versions through the production loader while keeping provider/backend execution independent of React.
- [x] Before-admission transforms are side-effect-free by contract and produce validated immutable prepared input. They cannot modify admitted submissions or perform an untracked effect.
- [x] Crash/disable/upgrade retains plain text and context references for plugin nodes. Unsupported nodes remain readable or prevent sending with an actionable explanation.
- [x] Capability, attachment and account validation applies to transformed input; the reviewed prepared payload equals the native delivered payload.
- [x] Activation cleanup and command registration follow existing lifecycle ownership; trusted plugin code is not described as a hostile-code sandbox.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use a real composer contribution in built Electron, compare prepared/native payloads and exercise ownership conflict, invalid transformation, crash and disable recovery.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Built; status left for review. Manifests declare `contributes.composer` (`id`, `version`, `node_kind`, `title`). A registered transform is a pure synchronous `({text, context_nodes}) => {text, context_nodes}`. Every registered transform runs in contribution-ID order on deeply frozen input, taken from the draft the daemon already saved. Output must be non-empty text of at most 1 MiB with the context references unchanged, because references are recorded with the send as the draft holds them; any other output skips the transform with a note. The composer shows "The provider receives this prompt" with the exact prepared text and the daemon's `context.plan` refusals. Send delivers that text through the existing send pipeline; the draft keeps what the person wrote. If the shown preview is stale, Send refuses once and refreshes it. Documented fallback: a plugin node (a `kind` containing a dot) that no working transform prepared sends its `data.text` appended to the prompt, as the preview states; a plugin node without `data.text` blocks Send with an explanation. Evidence: `e2e/desktop/plugin-ui.spec.ts` (previewed text equals the Codex `turn/start` input; a disabled plugin's node sends its plain text). Not built: an API for plugin UI to insert nodes into a draft (nodes come from `draft.save`). Queue and Steer send the raw text without transforms.

2026-10-02: Accepted after review and integration (decisions taken under the user's standing instruction to decide unattended).

The implementation above was built in an isolated worktree, reviewed, and applied to agent-work-2 together with the parallel work on tickets 20, 21 and 24–26 (conflicts in the workspace list, provider test runner and provider README merged by hand; generated contracts and the lockfile regenerated here, not copied). On the merged tree: `pnpm check:static` passed (`test-results/runs/static-e687aa37-a5b5-4dd7-b805-3de4575087b5`); `e2e/protocol/adapters` 24 passed with 3 opt-in live cases skipped, and `plugins/ui-contributions.spec.ts` passed; built Electron `acp.spec.ts`, `plugin-ui.spec.ts` and `opencode-plugin.spec.ts` 7/7.
Full runs on the merged tree: protocol 1097 passed, 6 failed, 8 skipped; the six also fail on HEAD (conversation delete after a daemon kill, lost turn, theme validation and three escaped-descendant cases). Desktop 118 passed; the `plugin-ui.spec.ts` cases failing in that run were caused by a fixture change made mid-run and pass 6/6 on the rebuilt tree (`test-results/runs/desktop-ea7ff3c7-a195-4965-b213-b4e50094c7b9`), with `appearance.spec.ts` density passing on rerun.

Fixed during review: Queue and Steer sent the raw editor text while Send sent the transformed, previewed prompt, so the reviewed payload could differ from the delivered one. Both now take the same prepared prompt Send does, and refuse with the same explanation when it is not ready. Evidence: new `e2e/desktop/plugin-ui.spec.ts` case "Queue delivers the same prepared prompt as Send while a turn runs". Still not built: an API for plugin UI to insert nodes into a draft.

2026-10-02 (ticket 32 reconciliation): added the missing upgrade evidence for criterion 3. `e2e/desktop/plugin-ui.spec.ts` "a draft with a plugin node keeps its text and reference across a plugin upgrade" disables the plugin, installs version 1.1.0 over 1.0.0 and enables it with the app open; the draft keeps its text and reference, the prepared preview returns, and Codex receives the previewed text (`desktop-8fa4850d-7a72-4304-8791-2892cf0eccd6`). Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
