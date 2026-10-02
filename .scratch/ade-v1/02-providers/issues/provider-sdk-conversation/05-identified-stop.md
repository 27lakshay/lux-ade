# 05 — Stop an identified execution truthfully

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Stop the identified active execution and distinguish requested cancellation from observed termination without stopping a successor or concealing queued work.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC08, PC09, PC16, PC23, PC28, PC36, PC37. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Stop declares its native scope and remaining queued/background work. A cancellation reply is acknowledgement; confirmed termination requires native or runtime-owned process evidence.
- [x] Late output and cancellation are fenced by attempt/turn identity. Waiting for the targeted attempt’s settlement includes its cleanup without following or cancelling successors.
- [x] Native queued input that can still execute prevents an unconditional stopped claim. Unsupported cancellation offers declared escalation or an explicit unresolved outcome.
- [x] Cancellation and cleanup have bounded completion paths even without a consuming event reader. Control remains available under ordinary output backpressure.
- [x] View closure only detaches presentation. Closing transports, suspending sessions and terminating owned processes remain separate actions with truthful limits.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Race Stop with dequeue, terminal output and successor startup through real processes; operate the built desktop and test absent event consumers and unconfirmed native stop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation (decisions taken under the user's standing instruction to decide unattended).

Decisions:
- `agent.cancel` waits at most 5 s for the provider's reply and returns `delivery` (`pending`, `acknowledged`, `refused`, `unknown`) with the provider's evidence; the reply never claims a stop. Reason: the backpressure and absent-consumer criteria need a bounded control reply.
- The Conversation carries one `stop` record (`ConversationStop`) per latest Stop, bound to its attempt and submission. It becomes `confirmed` only on the targeted submission's native terminal event (`native_terminal`) or a runtime-confirmed process exit (`process_exit`), and `unresolved` on refusal, on remaining queued native input, or when no terminal evidence arrives within 30 s (`ADE_E2E_STOP_SETTLE_MS` shortens it for tests). An unresolved Stop returns the conversation to `running`.
- A refused or failed cancellation no longer kills the provider implicitly (previously `fail_if` stopped it). The declared escalation is the new effect command `agent.terminate`, which ends the runtime-owned provider process and reports `process_exited` with its limits (child or background processes may survive). `agent.disconnect` stays the idle-only transport close; suspend is not offered (no current provider supports it).
- Daemon restart recovery reads the runtime's cancel receipt under its real key (`cancel:{attempt}:{submission}`); it previously used `cancel:{turn}` and reverted every delivered Stop to `running`. A delivered Stop no longer blocks `runtime.prepare_restart`; only one still pending delivery does.
- The Node provider SDK gives `cancel` its own dispatch lane and reply slot, so a slow `steer` or `answer` cannot hold it. The Claude worker reports input that the SDK still holds after an interrupt as `queued_work_count` instead of failing.
- CLI: `conversation cancel --wait` reports the settled stop record; `conversation terminate`. Desktop: Stop shows only while a submission is in flight; a provisional stop panel (`provisional/StopStatus.tsx`) renders requested/acknowledged/confirmed/unresolved, the remaining ADE queue and the terminate action.

Defects fixed while acceptance ran (each with a regression test that failed first):
- A Codex turn that finished before its `turn/start` reply was reopened by the late `Submitted` event and stayed `running` forever (flaky F034 queue tests; HEAD passed 1 of 3). `Submitted` and `Started` no longer reopen a finished or cancelling turn.
- Every Codex steer failed with "Provider returned invalid JSON": the native client replied `{turn}` where the worker contract requires the send-result shape.
- Refusing a stale native request (late stream of a cancelled turn) used the pre-04 answer shape and, failing, failed the successor turn. The runtime now sends a typed refusal, a failed `reject` no longer ends the run, and the Codex native client answers a refusal even after the turn's request was dropped.
- F031 output past 1 MiB disconnected Codex: native frames were capped at 1 MiB, worker output frames at 1 MiB, the decoded-value budget at 2 MiB and the retained window at 512 KiB per message. Native Codex frames and worker output frames now allow 4 MiB, items are cut to one stored message with the marker before crossing a worker frame, the decoded reservation is 16 MiB, and `conversation.get` keeps the newest messages that fit a 4 MiB window instead of refusing the whole read.
- The Codex native client and its SDK worker failed the session when 32 events queued; both now apply bounded backpressure (30 s) to the native pipe.
- The fake-Claude loader's `ExperimentalWarning` reached every CLI's stderr and broke JSON errors in all CLI tests; the fixture now disables that warning. The native client now writes its own sanitized diagnostics, so native provider stderr is accounted by size.

Acceptance evidence (2026-10-02). All runs are against real daemon/runtime processes and the deterministic Codex and fake-Claude fixtures; none is installed-provider or authenticated live evidence.

| Criterion | Evidence |
|---|---|
| Declared scope, acknowledgement vs confirmation | `e2e/protocol/conversations/stop.spec.ts` (CLI `--wait` waits past acknowledgement for native terminal evidence; unresolved after an acknowledged interrupt with no terminal; refused cancel keeps the turn and provider), `controls.spec.ts`, `send-queue.spec.ts` (stop record `confirmed`/`native_terminal`), `ConversationStop` unit tests in `crates/ade-core/src/contract/agents.rs` |
| Attempt/turn fencing; settlement without touching successors | `reliability-a/cancel-fencing.spec.ts` (5 cases incl. new restart regression and held reply), `reliability-core/stream-fencing.spec.ts` (3 successor kinds), `conversations/send-queue.spec.ts` early-finish regression |
| Native queued input; unsupported cancellation | `stop.spec.ts` Claude queued input stays unresolved; `providers/claude/worker.test.mjs` queued interrupt; refused-cancel case; `agent.terminate` escalation |
| Bounded completion without consumer; control under backpressure | held-reply case returns `pending` within the bound; `plugins/provider-sdk.spec.ts` cancel lane while steer holds the control lane (failed before the fix); `reliability-a/overload.spec.ts`; `recovery/receipt-saturation.spec.ts`; `control-lane.spec.ts` |
| View closure only detaches | `e2e/desktop/conversation.spec.ts` (existing); separate close (`agent.disconnect`), terminate (`agent.terminate`) with stated limits; suspend not offered |
| Records and gates | below |

Commands and results:
- `pnpm check:static`: passed (`test-results/runs/static-8edc9076-1327-468f-ac44-93cc8600b0a9`; 897 Rust tests passed, 1 skipped; 450 renderer tests).
- `pnpm test:e2e:protocol:only` (full ordinary suite): 1036 passed, 49 failed, 5 skipped (`test-results/runs/protocol-08790666-e6c4-42b0-a30f-784fff3871a8`). No failure is in a Stop, cancel, queue or stream path. 27 failures are Claude cases that need the richer fake SDK (rewind, account switch, usage, commands, attachments, MCP, skills, CLI answers, child questions) and move to ticket 06. 22 also fail on a clean build of commit 48949704 (plugin drain/reload/update/recovery, escaped-descendant quarantine, stale rewind, delete, compaction, lost turn, theme validation, readiness, host resources, operation coverage, plugin registry) and are recorded as pre-existing, not accepted here.
- `pnpm test:e2e:desktop:only` (full): 94 passed, 4 failed (`test-results/runs/desktop-78e44b3c-f4b6-481c-abe5-40d4ee4a51e6`). Two were test-helper races (empty view ID before render), fixed in `e2e/desktop/send.spec.ts` and passing 5/5. Two (`send.spec.ts` two-view draft conflict; admitted intent after Electron restart) also fail with the commit's composer and belong to ticket 15.
- Built Electron Stop: `send.spec.ts` confirmed native stop, and unresolved Stop then termination, with screenshots `stop-unresolved.png` and `stop-terminated.png` (`test-results/runs/desktop-65e4e608-ddaa-4e41-80ac-2aea2f375eca`).

Not run: installed or authenticated Codex, Claude and OMP Stop; OMP and Claude interruption against native binaries (tickets 06, 07, 31).
