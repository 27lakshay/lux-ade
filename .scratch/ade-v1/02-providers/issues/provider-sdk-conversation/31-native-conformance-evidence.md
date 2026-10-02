# 31 — Verify native fidelity and publish provider conformance evidence

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Verify completed provider behavior through the reusable real-process conformance harness and publish separate deterministic and installed/live capability evidence.

**Blocked by:** [04 — Answer native approvals and structured questions](04-native-requests.md), [05 — Stop an identified execution truthfully](05-identified-stop.md), [06 — Run Claude Code through the public provider SDK](06-claude-native-adapter.md), [07 — Run Oh My Pi through the public provider SDK](07-omp-native-adapter.md), [08 — Apply provider settings with accurate effective state](08-effective-provider-settings.md), [09 — Bind executions to explicit account contexts](09-explicit-account-context.md), [10 — Queue, remove and steer input without changing its meaning](10-queue-remove-steer.md), [11 — Show yielded, background and autonomous activity](11-background-activity.md), [13 — Reconnect and merge history with live output](13-reconnect-live-merge.md), [14 — Recover uncertain sends and failed executions](14-uncertain-execution-recovery.md), [16 — Preview and validate attachments and captured context](16-prepared-context-attachments.md), [17 — Run provider commands and skills with explicit semantics](17-provider-commands-skills.md), [18 — Compact context with native evidence](18-native-compaction.md), [19 — Preview and execute rewind with lineage](19-rewind-lineage.md), [20 — Connect generic ACP agents with negotiated semantics](20-generic-acp.md), [21 — Install a real fourth provider without core changes](21-independent-real-provider.md), [22 — Configure native provider MCP access through the public contract](22-provider-mcp.md), [23 — Preserve active work across plugin lifecycle changes](23-plugin-leased-executions.md), [27 — Inspect child activity, usage and quota evidence](27-child-usage-evidence.md), [28 — Retain access to history after provider removal](28-retained-history-access.md)

**Spec coverage:** PC01, PC02, PC03, PC04, PC05, PC06, PC07, PC08, PC09, PC10, PC11, PC12, PC13, PC14, PC15, PC17, PC18, PC19, PC20, PC21, PC28, PC29, PC30, PC31, PC32, PC34, PC35, PC36, PC37, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Consolidate conformance cases already added by preceding slices; run installed worker artifacts through the actual daemon/runtime with shared native protocol fixtures, not a second in-process supervisor.
- [ ] Exercise each declared operation for Codex, Claude, OMP, generic ACP and the independently installed provider, including advanced operations and extension tier/schema failures; unsupported optional behavior is explicit.
- [ ] Compare mandatory public SDK/worker behavior against bundled adapters and reject any privileged route that prevents independent authors from implementing the same supported semantics.
- [ ] Record exact ADE artifact, worker digest, native/toolchain/Effect versions, account context, capability matrix and native prerequisites for each run.
- [ ] Keep fixture, installed-provider, authenticated live, packaged-candidate and performance results separate. Missing credentials/executables or unsupported capabilities remain gaps rather than a passing native claim.
- [ ] Obtain mandatory installed/live evidence for the primary three and real fourth integration, plus applicable ACP evidence, before declaring provider coverage accepted. Correctness retries remain zero.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Run the existing ordinary acceptance and relevant native/package/live suites. This is evidence consolidation, not deferred test creation; isolate any genuine uncovered behavior as unfinished acceptance.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
