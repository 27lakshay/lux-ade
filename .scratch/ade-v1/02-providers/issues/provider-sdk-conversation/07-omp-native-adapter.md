# 07 — Run Oh My Pi through the public provider SDK

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Run native Oh My Pi in the production conversation while distinguishing acknowledgement, completion and the background evidence its installed version actually supplies.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC02, PC05, PC06, PC08, PC09, PC10, PC11, PC12, PC30, PC31. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Select OMP, send a native turn and display text/tools through the public worker contract and the shared UI.
- [x] Negotiate or inspect exact native protocol/version support. The inspected old pin does not inherit newer upstream settlement semantics automatically.
- [x] Prompt acceptance, local command completion, yielded execution and supported background settlement remain independent facts. Missing settlement evidence is unknown or unavailable.
- [x] Map supported requests, cancellation, queued input and child observations with stable native correlation; stale or autonomous events cannot invent a user submission.
- [x] Record OMP’s capability matrix and fixture/installed/live evidence separately, preserving native fidelity without core provider-name branches.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Exercise acknowledgement-before-output, late completion, interrupt and autonomous output with deterministic RPC peers and built desktop; record exact installed OMP evidence separately.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
2026-10-02: Inspected workspace pin `@oh-my-pi/pi-coding-agent` 18.3.0 (`omp --version`: `omp/18.3.0`), installed RPC source and upstream RPC reference. The existing transport negotiates protocol v2 with 1 MiB physical / 64 MiB reassembled limits; prompt ack is separate from `agent_end`; `prompt_result(agentInvoked:false)` is local prompt work; abort plus idle `get_state` is observable stop evidence, not a native cancellation cause; no independent background settlement signal was identified. Focused deterministic RPC-peer/bridge command `bun test providers/omp/transport.test.mjs providers/omp/bridge.test.mjs` passed 12 tests / 28 assertions. Public Effect worker migration, history page implementation, built-desktop and exact installed real-process adapter evidence remain unverified; no acceptance checkbox is changed.
2026-10-02: Added `providers/omp/worker.mjs` using the public Effect worker contract. Initial deterministic process smoke (`bun test providers/omp/worker-peer.test.mjs`) launched the worker over stdio and a native RPC peer subprocess, opened a session and sent a prompt, observed `submitted` without an invented native turn, streamed assistant text, and kept uncorrelated `agent_end` unattributed while retaining its explicit native stop status. This proves the adapter path only, not shared UI/launcher integration, built-desktop acceptance or live installed-provider acceptance; ticket remains in progress.
2026-10-02: Expanded worker parity with prompt-local completion before acknowledgement, late prompt failure during a following send, native approval/question answers, tool projection, post-interrupt state evidence, session-local child lifecycle/transcript paging, and bounded child-reference cleanup. Focused helper suite `bun test providers/omp/child-transcripts.test.mjs providers/omp/subagents.test.mjs providers/omp/transport.test.mjs providers/omp/history.test.mjs providers/omp/session.test.mjs providers/omp/stream.test.mjs providers/omp/admission.test.mjs` passed 30 tests / 103 assertions; `node --check` passed for the worker and process fixtures. The expanded public-worker process smoke is authored but not rerun: direct SDK/Effect dependencies and generated cancel-result integration are not yet installed. Built-desktop and live installed-provider acceptance remain unverified.
2026-10-02: Pinned-source review verified RPC `abort` awaits `session.abort` (`providers/omp/node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-mode.ts:1261-1264`), and following `get_state` returns session activity, compaction, queue count, ID and file (`rpc-mode.ts:1286-1314`). `agent-session.ts:5364-5365` defines streaming as agent streaming or prompts in flight; `:7935-7943` counts steering, follow-up and next-turn messages. The worker checks returned native ID/file against its opened identity before attaching the sample timestamp; verified idle samples may report foreground false and queue 0, while absent/mismatched samples report nulls. Background settlement and terminal cause remain unknown. The deterministic public-process fixture now covers both verified idle and mismatched-session evidence; that process smoke still awaits shared package integration.
2026-10-02: `ADE_OMP_LOOPBACK=1 bun test providers/omp/loopback.test.mjs` passed (1 test / 12 assertions) against installed OMP 18.3.0 with its account/config environment isolated and a local deterministic model endpoint. This exercises native protocol execution, two response turns and history resume; it is not a live credentialed provider run or public SDK worker acceptance.
2026-10-02: `bun test providers/omp/worker-peer.test.mjs` passed (1 test / 27 assertions) after the method-result cancellation contract update. The subprocess test covers native request metadata/answers, history paging, tool and child projections, local-only completion, late failure correlation, post-abort evidence (including wrong-session nulls), and no cancel event. The worker now ignores uncorrelated `agent_end` for attempt ownership and only clears stale attempts after verified idle state or RPC-correlated local completion. Helper tests passed (30 / 103 assertions); the isolated installed OMP loopback passed (1 / 12). Shared UI, built-desktop, and live credentialed acceptance remain unverified.
2026-10-02: Fixed the question schema/answer mismatch: published question ID and answer parser both use `input`, with no `value` compatibility alias. The schema-derived peer regression failed before the fix with `invalid_request`; malformed answers leave the pending native question intact. `ADE_OMP_LOOPBACK=1 bun test providers/omp/worker-peer.test.mjs` passed 2 tests / 39 assertions. The installed-native-only command `ADE_OMP_LOOPBACK=1 bun test providers/omp/worker-peer.test.mjs --test-name-pattern "installed OMP public worker"` passed 1 test / 11 assertions (one fixture test filtered). It runs the actual public SDK worker and installed OMP 18.3.0: a native `before_agent_start` extension asks `ctx.ui.input`, the published-schema answer resumes that hook, computes budget 42 from answer 21, and changes the actual local model request before streamed completion; malformed and stale answers are rejected. Native hook source uses `systemPrompt: string[]`; the shipped `pirate.ts` example incorrectly documents `systemPromptAppend`, which this regression does not use. This proves public-worker open/send/question-answer/text/native completion, not Stop/tools/children/Desktop/live. The separate legacy Bridge loopback only proves two-turn stream/context/history/resume/no-resubmission. Ticket status and checkboxes remain unchanged.

2026-10-02: Production wiring and acceptance (decisions taken under the user's standing instruction to decide unattended).

Decisions and fixes:
- OMP conversations now run through the public worker: `launch_omp` calls `Worker::spawn_omp`, which runs `providers/omp/worker.mjs` under Bun (the worker imports OMP's TypeScript RPC frame sources, which Node cannot load from node_modules) with the `omp::worker_descriptor()` metadata (steer and rewind unsupported). Managed accounts keep `--no-env-file`, the pinned identity and `ADE_OMP_EXPECTED_PROVIDER`; identity and workspace credential sources are re-checked before every open and send through a worker preflight hook. The old Bun bridge adapter (`omp.rs::Adapter`, `bridge.mjs`) is no longer launched; its removal is left to the D19 cleanup with the Claude bridge.
- Completion attribution: OMP's `agent_end` carries no RPC correlation. The worker now records the attempt current at each run's `agent_start` and settles exactly that attempt at its `agent_end`; a late end from an older run cannot settle a newer prompt, and a run with no observed start stays unattributed. Before this, every OMP turn stayed `running` in the daemon. The peer expectations that finishes stay unattributed were updated accordingly, and the deterministic peers (`mock-cli.mjs`, `e2e/fixtures/omp_account_cli.mjs`) now emit `agent_start` as native OMP does; `hold*` prompts are held.
- Prompt echo: the first user entry with the exact admitted text after a serialized send is linked to the admitted native message ID (in the live stream and in history reconciliation), so it merges into the ADE message instead of becoming a second user message.
- MCP: a launch with no catalog servers removes the ADE extension package, as the bridge did.
- Capability matrix with fixture/installed/live evidence kinds: `providers/omp/README.md`.

Evidence (deterministic RPC peers; not installed or live provider evidence):
- `pnpm check:static`: passed (`test-results/runs/static-63db502a-7eca-4904-b776-e596a33a8930`).
- `cd providers/omp && bun test worker-peer.test.mjs`: 1 pass, 1 installed-only skip (from the repository root the peer test cannot initialize the worker because of the working directory; it is outside the gate catalog).
- Protocol (`test-results/runs/protocol-f0ab575f-9f65-42b3-a5eb-3d951d132e6f`): OMP MCP launch/resume (2), managed OMP accounts with drift and `.env` refusal, OMP capabilities and quota pass. The listed failures are Claude rewind/usage (tickets 19, 27) and cases that also fail on commit 48949704.
- Built Electron `e2e/desktop/omp.spec.ts` (`test-results/runs/desktop-bfbcfcba-9fb9-4ba0-ad6b-ebb4f54aac17`): an OMP turn renders "Hello Oh My Pi" with one attributed user message; Stop on a held run is confirmed by OMP's own interrupted end; screenshot `omp-stopped.png`.

Prerequisite-blocked: installed-OMP daemon acceptance and live credentialed OMP. The earlier installed loopback (`ADE_OMP_LOOPBACK=1`) remains the installed evidence for the native protocol.

2026-10-02 (PC02 parity): D19 cleanup done. The old Bun bridge adapter is deleted: `omp.rs::Adapter`, `providers/omp/bridge.mjs` and its tests, and the bridge-only `submissions.mjs`, `admit` and `ChildTranscripts`. The installed-OMP check is now the worker's loopback case in `worker-peer.test.mjs` (`ADE_OMP_LOOPBACK=1`).
