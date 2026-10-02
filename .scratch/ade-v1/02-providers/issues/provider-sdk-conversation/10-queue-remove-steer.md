# 10 — Queue, remove and steer input without changing its meaning

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Prepare follow-up input, remove it where supported or steer an identified active turn without confusing local queues, native acceptance and redirection.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [05 — Stop an identified execution truthfully](05-identified-stop.md)

**Spec coverage:** PC04, PC06, PC07, PC08, PC37. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Expose Send, Queue and Steer only with declared semantics and current availability. CLI/SDK actions and desktop shortcuts cannot substitute one for another.
- [x] Show whether input is ADE-pending, adapter-buffered or native-owned. Local removal cannot claim to recall already accepted native work.
- [x] Steering targets a specific active native turn and fails on a stale target. Unsupported steering is explicit rather than another prompt.
- [x] Cancellation discloses queued work that remains or applies supported scoped removal/escalation; a late queue acknowledgement cannot settle a successor.
- [x] Work admitted during draining/cleanup survives and starts once when eligible. Different-payload operation reuse remains a conflict, not first-payload-wins.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Race queue ownership handoff, removal, steering and cleanup with deterministic native peers; assert actual received input and built-desktop queue states.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Decisions:
- The backend already kept Send (`agent.send`), Queue (`queue.enqueue`/`queue.cancel`/`queue.pause`) and Steer (`conversation.steer` on a named turn, refused when stale or unsupported) as separate effect operations; the CLI exposed each. The desktop exposed only Send. It now offers Queue and Steer as separate buttons while a submission is in flight or prompts are queued, and Enter only ever sends (a busy Enter explains the choice instead of acting). Steer shows its availability and reason from `conversation.controls` for the active turn.
- Ownership labels: queued entries read "Waiting in ADE's queue · not sent to the provider" in a provisional queue panel (position, pause/resume, remove from ADE's queue only). A sent prompt reads "Held by the provider adapter" (dispatch pending), "Sent to the native agent; awaiting its acceptance" (dispatched) or "Accepted by native agent". No provider offers native queued-input removal; none is claimed.
- Queue and Steer keep their request or operation ID with their text, so a retry after a lost reply reuses it and the daemon answers from its receipt; a changed text gets a new ID. Reuse of an ID with another payload stays a conflict (store and envelope behaviour unchanged).
- The SDK conversation projection now carries the prompt queue from every change frame; it previously kept only the first read's queue.
- Stop discloses prompts remaining in ADE's queue and whether the queue is paused (ticket 05 panel).

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-119beec5-eb6d-4233-8f77-ba0bb9bdb12a`; 897 Rust tests passed, 1 skipped; 451 renderer tests).
- Renderer: `FollowUpInput.test.tsx` (steer targets the running turn and clears the draft only after acknowledgement; unsupported steer stays explicit; Queue adds and Remove drops only ADE's entry; Enter while busy sends nothing; adapter/native ownership labels); `packages/client/src/sync.test.mjs` queue projection.
- Real processes: full protocol run `test-results/runs/protocol-08790666-e6c4-42b0-a30f-784fff3871a8` passes every queue, steer and cancel-race case (`conversations/send-queue.spec.ts` including different-payload conflict and the new early-finish regression, `conversations/controls.spec.ts` F035 steer cases, `reliability-core/stream-fencing.spec.ts` queued wake during cleanup, `reliability-a/cancel-fencing.spec.ts`). Its unrelated failures are listed on ticket 05.
- Built Electron: `e2e/desktop/follow-up.spec.ts` (Queue held by ADE with no second `turn/start`; Steer reaches `turn/steer` with the active turn ID; Enter sends nothing while busy; Remove drops only the ADE entry), run `test-results/runs/desktop-1ee859c2-ba06-4744-80b6-214fcaffa2a3`, screenshot `queued-prompt.png`.

Not run: steering against installed Codex; Claude and OMP have no native steer path and report it unavailable.
