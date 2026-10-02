# 32 — Freeze the authoring contract with complete acceptance coverage

Status: ready-for-human
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Give provider authors a documented, tested contract whose complete lifecycle and UI extension behavior has verified acceptance rather than types alone.

**Blocked by:** [26 — Recover from thrown and frozen UI extensions](26-extension-safe-mode.md), [29 — Preserve reading position and accessible interaction](29-accessible-reading.md), [30 — Keep conversations and control responsive under load](30-responsive-under-load.md), [31 — Verify native fidelity and publish provider conformance evidence](31-native-conformance-evidence.md)

**Spec coverage:** PC01, PC02, PC03, PC04, PC05, PC06, PC07, PC08, PC09, PC10, PC11, PC12, PC13, PC14, PC15, PC16, PC17, PC18, PC19, PC20, PC21, PC22, PC23, PC24, PC25, PC26, PC27, PC28, PC29, PC30, PC31, PC32, PC33, PC34, PC35, PC36, PC37, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Reconcile all PC01–PC38 contributions and all 78 user stories against evidence from the completed tickets; a covered row is not accepted until every required contributing behavior passes.
- [x] Publish authoring guidance for capabilities, tiers, admission, ordering, identities, settings, requests, cancellation, reconciliation, history consistency, scopes, framing and independent packaging.
- [x] Document the small Effect service/lifetime conventions, generated Rust-owned authority, exact compatible package set and agent resources; preserve explicit limits for optional AI/MCP/observability dependencies.
- [x] Verify core-readable history and backend/UI separation with independently installed timeline/composer contributions, missing renderers and safe-mode recovery.
- [x] Record measured resource policy, installed/live prerequisites and any remaining limitations without claiming unsupported parity or exact-once external execution.
- [x] Do not freeze while mandatory acceptance gaps remain. Preserve existing feature dispositions and earlier evidence, updating delivery acceptance only for the behavior actually proven.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Reconcile reports from all contributing tickets and run the applicable full ordinary/integration gates against the final artifact. Freeze requires documentation and evidence review, not only a successful typecheck.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: reconciliation and authoring contract (unattended run; decisions taken without asking).

**Reconciliation.** Every PC row and user story was reconciled against ticket evidence (`/tmp/claude-501/reconciliation.md` holds the row-by-row table). That pass left 10 rows and 13 stories not accepted. This ticket then built what was missing, or recorded why it cannot be closed here:

| Gap | Outcome | Evidence |
|---|---|---|
| PC02 / story 64: bundled controls decided by provider name; plugins lacked MCP and managed-account context | Closed. Every worker-backed provider's controls follow its declared operations; plugins receive `configure_mcp` and the public `ADE_ACCOUNT_CONTEXT`, declare `account_inspect` for managed accounts, can switch accounts and take delegated children on managed accounts. The old in-process Claude and Oh My Pi bridges were deleted (D19). | `adapters/plugin-providers.spec.ts` (MCP, managed account, switch and delegation), `context/compaction.spec.ts` (Oh My Pi compaction from its declaration) |
| PC24 / story 34: text typed inside the 250 ms draft delay was lost on a renderer crash; no upgrade evidence | Closed (ticket 15 and 25 comments) | `desktop/draft-crash.spec.ts`, `desktop/plugin-ui.spec.ts` upgrade case |
| PC25 / story 32: no captured-context preview | Closed (ticket 16 comment) | `desktop/draft-context.spec.ts` |
| PC26 / story 16: no on-demand expansion keeping the reading anchor | Closed (ticket 29 comment). Limit: no screen-reader run. | `desktop/reading.spec.ts` |
| PC27 / story 56: no Electron mount or rendering measurement | Closed for one machine (ticket 30 comment) | `desktop/conversation-performance.spec.ts` |
| PC32 / stories 9, 72: no native model discovery; no dependent-update failure test | Closed (ticket 08 comment): Codex `model/list`, Claude `initializationResult().models`, Oh My Pi `get_available_models`; choices carry their source; a dependent value the new model does not offer refuses the whole update with nothing applied | `conversations/settings.spec.ts`, `desktop/settings.spec.ts` |
| PC33 / story 73: no visible-ordering burst test | Closed. It found and fixed a Codex worker overflow under bursts (ticket 30 comment). | `conversations/burst.spec.ts`, `desktop/burst-ordering.spec.ts` |
| PC34: same native ID across accounts only in-process | Closed (ticket 09 comment) | `providers/shared-native-id.spec.ts` |
| PC35: no compaction tool-repeat fixture | Closed. It found and fixed a turn-provenance overwrite (ticket 18 comment). | `context/compaction.spec.ts` |
| Story 66: no author conformance harness | Closed. `@ade/provider-sdk/testing` with a CLI (`ade-provider-conformance`) and `pnpm test:conformance` run 13 worker-protocol checks against a worker and its native double. 21 self-tests include 16 deliberately broken workers, each failing exactly its check. The harness found that Claude, ACP and OpenCode ran a retried send again; the SDK runner now answers a repeated submission with the first send's reply, and all three pass 13/13. | `packages/provider-sdk/src/testing.test.mjs`, `providers/*/conformance.test.mjs`, `plugins/opencode/test/conformance.test.mjs` |
| Story 77: Effect conventions and agent resources undocumented | Closed. `docs/provider-authoring.md` "Effect conventions" covers services, lifetimes, queues and streams, errors, diagnostics, and Effect's `llms.txt` and v4 `LLMS.md`. | doc review |
| PC30 / story 69: installed/live evidence for every mandatory behaviour | **Not closed.** Added live Codex steering (`live-provider-38fb3528-644c-4380-8469-523f09721865`: the steered input reached the running turn). Still fixture-only: Claude background Bash tasks, Claude rewind through the daemon, Oh My Pi child activity and queue, OpenCode Stop, permissions and child transcripts, generic ACP cancellation and permissions. No managed-account (ADE-isolated login) live run exists for any provider; it needs a person to sign in to fresh accounts. | `docs/provider-conformance.md` gaps |
| Story 18: command and file changes link to ADE resources | **Not closed, blocked.** The ADE resources a change would link to (the inspector's Changes and Files views, file and diff panes) are still empty placeholders owned by other specifications; there is nothing to link to yet. | `features/workspace/sidebars/Inspector.tsx` |
| Story 70: each slice measured as it lands | **Not closed, cannot be made retroactively true.** Budgets exist from ticket 30 onward (headless and now Electron); earlier slices were not measured when they landed. | ticket 30 |

**Documents corrected where they disagreed with the code:**
- The tracker README's opening paragraph.
- Ticket 30's `feed_overflow` claim (no deterministic test of delivery to a still-reading client, as ticket 13 says).
- The parent spec's MCP "gateway" wording (v1 delivers directly).
- `docs/provider-conformance.md` privileged routes (bundled controls are no longer named by provider).

**Authoring contract.** `docs/provider-authoring.md` (capabilities, tiers, admission, ordering, identities, settings, requests, cancellation, reconciliation, history, scopes, managed accounts, framing, packaging, Effect conventions, conformance checks without ADE), `docs/provider-worker-protocol.md`, and `docs/provider-conformance.md` (evidence tiers, matrix, declared capabilities, privileged routes, defects found, gaps).

**Freeze decision: not frozen.** The ticket forbids freezing while mandatory gaps remain, and PC30 is mandatory. Stories 18 and 70 are also recorded as not accepted above. Status is `ready-for-human`, because closing PC30 needs managed accounts signed in by a person and further opt-in live runs beyond this run's two-prompt limit.

**Gates on the final tree:**
- Static: `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16` passed.
- Full protocol: `protocol-96876d9c-01d2-48b0-a527-f039a873f725`, 1109 passed, 6 failed, 8 skipped.
- Full desktop: `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11`, 130 passed, 2 failed.
- Failures already present on the base commit 48949704: `delete.spec.ts:264`, `theme-validation.spec.ts:15`, `runtime-crash.spec.ts:93`, `agent-descendants.spec.ts:36` and `uncertainty.spec.ts:95` fail the same way there and are left as found.
- Load-timing failures in the full runs that pass when run alone: `runtime-crash.spec.ts:40` (twice), desktop `recovery.spec.ts` (3 of 3), and desktop `appearance.spec.ts:1471` density focus (it loses OS focus to parallel Electron workers; already recorded as a flake).
- Fixed on the way: the base commit's `lost-turn.spec.ts` daemon-survives failure (ticket 14 comment); `reliability-c/plugin-update.spec.ts`, whose text patch of the fixture worker imported `existsSync` twice after the fixture gained it; and the renderer-hang test in `desktop/plugin-ui.spec.ts`, which now enters its freezing text as one edit because drafts save on each edit..
