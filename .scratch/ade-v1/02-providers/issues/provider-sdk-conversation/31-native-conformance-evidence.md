# 31 — Verify native fidelity and publish provider conformance evidence

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Verify completed provider behavior through the reusable real-process conformance harness and publish separate deterministic and installed/live capability evidence.

**Blocked by:** [04 — Answer native approvals and structured questions](04-native-requests.md), [05 — Stop an identified execution truthfully](05-identified-stop.md), [06 — Run Claude Code through the public provider SDK](06-claude-native-adapter.md), [07 — Run Oh My Pi through the public provider SDK](07-omp-native-adapter.md), [08 — Apply provider settings with accurate effective state](08-effective-provider-settings.md), [09 — Bind executions to explicit account contexts](09-explicit-account-context.md), [10 — Queue, remove and steer input without changing its meaning](10-queue-remove-steer.md), [11 — Show yielded, background and autonomous activity](11-background-activity.md), [13 — Reconnect and merge history with live output](13-reconnect-live-merge.md), [14 — Recover uncertain sends and failed executions](14-uncertain-execution-recovery.md), [16 — Preview and validate attachments and captured context](16-prepared-context-attachments.md), [17 — Run provider commands and skills with explicit semantics](17-provider-commands-skills.md), [18 — Compact context with native evidence](18-native-compaction.md), [19 — Preview and execute rewind with lineage](19-rewind-lineage.md), [20 — Connect generic ACP agents with negotiated semantics](20-generic-acp.md), [21 — Install a real fourth provider without core changes](21-independent-real-provider.md), [22 — Configure native provider MCP access through the public contract](22-provider-mcp.md), [23 — Preserve active work across plugin lifecycle changes](23-plugin-leased-executions.md), [27 — Inspect child activity, usage and quota evidence](27-child-usage-evidence.md), [28 — Retain access to history after provider removal](28-retained-history-access.md)

**Spec coverage:** PC01, PC02, PC03, PC04, PC05, PC06, PC07, PC08, PC09, PC10, PC11, PC12, PC13, PC14, PC15, PC17, PC18, PC19, PC20, PC21, PC28, PC29, PC30, PC31, PC32, PC34, PC35, PC36, PC37, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Consolidate conformance cases already added by preceding slices; run installed worker artifacts through the actual daemon/runtime with shared native protocol fixtures, not a second in-process supervisor.
- [x] Exercise each declared operation for Codex, Claude, OMP, generic ACP and the independently installed provider, including advanced operations and extension tier/schema failures; unsupported optional behavior is explicit.
- [x] Compare mandatory public SDK/worker behavior against bundled adapters and reject any privileged route that prevents independent authors from implementing the same supported semantics.
- [x] Record exact ADE artifact, worker digest, native/toolchain/Effect versions, account context, capability matrix and native prerequisites for each run.
- [x] Keep fixture, installed-provider, authenticated live, packaged-candidate and performance results separate. Missing credentials/executables or unsupported capabilities remain gaps rather than a passing native claim.
- [x] Obtain mandatory installed/live evidence for the primary three and real fourth integration, plus applicable ACP evidence, before declaring provider coverage accepted. Correctness retries remain zero.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Run the existing ordinary acceptance and relevant native/package/live suites. This is evidence consolidation, not deferred test creation; isolate any genuine uncovered behavior as unfinished acceptance.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

The consolidated evidence is published in [docs/provider-conformance.md](../../../../../docs/provider-conformance.md): tiers, the matrix of native versions and run IDs per provider, declared capabilities, privileged routes and gaps.

Installed and authenticated live evidence for the primary three providers (real daemon and runtime, disposable ADE profile, native HOME and credentials; `ADE_RUN_LIVE_PROVIDERS=1 pnpm test:e2e:live <provider> --tool-probe --cancel-probe --approval-probe`):

| Provider | Native version | Result | Run |
| --- | --- | --- | --- |
| Codex | codex-cli 0.159.0 | pass: reply, tool use, Stop then resume, approval answered once (retry acknowledged, conflicting answer refused, file written), decline via the offered `cancel` (file not written) | `test-results/runs/live-provider-c8b775a3-0c1b-46fa-9087-7f2b074aa5e5` |
| Claude Code | 2.1.287 | pass: same steps; the tool step's native Read permission approved only for the probe's own file; decline via `deny` | `test-results/runs/live-provider-21ba2d39-dfd5-44f3-b13a-4dddbb8bf99d` |
| Oh My Pi | 18.4.10 | pass: reply, tool use, Stop then resume; approval not applicable (no native tool approval; see below) | `test-results/runs/live-provider-4e5ade70-9165-41fa-b945-d733e9654851` |

The live probe (`scripts/live_provider_check.py`) had drifted from the contracts: page limit above 32, `ready` only (idle is now reported), the pre-ticket-04 untyped `agent.answer`, request `status`/`params` fields that the public request does not carry, a cancel without attempt and submission IDs, and a keyword match that picked an accept choice because its value contained a path with "declined". It now uses the typed contracts, matches a request to the probe's exact disposable file through the request's summary or its linked native tool call, picks choices by exact name (or a structured choice's `decision`), skips approval for a provider that declares no `tool_approval`, and prints its own stack (never provider text) with `ADE_LIVE_DEBUG=1`.

Defects the live run found and fixed:
- Oh My Pi: installed OMP 18.4 acknowledged an abort and went idle without `agent_end`, so the turn stayed running and the Stop stayed unresolved. The worker now ends the attempt as interrupted from the post-abort idle sample with nothing queued (`providers/omp/worker.mjs`); the OMP CLI fixture reproduces the behaviour (`hold-silent-abort`) and `conversations/stop.spec.ts` covers it.
- Oh My Pi declared `tool_approval` but ran its built-in bash tool without asking; it now declares tool approval unsupported (only extension confirmations reach ADE, as requests), in the worker descriptor, the static catalog and its README.

Privileged route removed: conversation controls were decided by provider name, and every provider plugin was refused steer, compact and rewind whatever its worker declared. The daemon now records each plugin worker's declared operations at its handshake (gathered before any control decision, cached per artifact) and offers a control exactly when the worker declares it available, with the worker's own reason otherwise. Evidence: unit test `a_plugin_worker_gets_the_controls_it_declares_with_its_own_reasons`; `e2e/protocol/adapters/plugin-providers.spec.ts` (a fixture plugin's declared `compact` is offered as `worker.compact` and performed once under a receipt; an undeclared rewind and a declared-unsupported steer report why). The OpenCode plugin's reasons no longer claim ADE refuses these controls.

ACP and OpenCode evidence comes from tickets 20 and 21 (installed `opencode acp` and `opencode serve`, live replies, artifact digest), consolidated in the same document.

Evidence: `pnpm check:static` passed (`test-results/runs/static-a45da8a7-4ec5-4c3e-9956-fcd06c45ce08`); `plugins/opencode` 56/56; `adapters/plugin-providers.spec.ts` and `opencode-plugin.spec.ts` 10/10; controls and compaction specs 19/19.

Gaps (also in the document): generic ACP verified live only against OpenCode's ACP mode for completion and resume; OpenCode Stop, permissions and child transcripts fixture-only; no managed-account live run; the Oh My Pi package pin (18.3.0) differs from the installed binary (18.4.10).

2026-10-02 (ticket 32 reconciliation):
- The privileged route recorded above as kept is gone. Every worker-backed provider's controls follow its declared operations, with mechanism names such as `worker.compact`, and the old in-process Claude and Oh My Pi bridges are deleted.
- Provider plugins now receive `configure_mcp` and the public `ADE_ACCOUNT_CONTEXT` like bundled workers. A plugin that declares `account_inspect` gets managed accounts, account switching and delegated children on managed accounts. Tests: `adapters/plugin-providers.spec.ts`; Oh My Pi compaction from its declaration in `context/compaction.spec.ts`.
- Live Codex steering was added to the probe (`--steer-probe`; `live-provider-38fb3528-644c-4380-8469-523f09721865`). The steered input reached the running turn and only one turn ran.
- The author conformance harness (`@ade/provider-sdk/testing`, `pnpm test:conformance`) found that Claude, ACP and OpenCode ran a retried send again. The SDK runner now answers a repeated submission with the first send's reply (`packages/provider-sdk/src/node.ts`), and all three pass 13/13.
- Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
