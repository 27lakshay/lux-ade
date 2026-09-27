# E2E round 3: reliability-a

Status: returned
Type: slice evidence
Branch: claude/wf_317b0f50-41b-2
Worker: ADE parallel build, E2E round 3, reliability-a worker
Requirements: R001, R002, R003, R004 (none fully accepted)

## Outcome

No requirement's full register acceptance passes. `e2e/protocol/reliability-a/`
holds 59 passing tests and 22 `test.fixme`. The specs found three product bugs,
all fixed and proven:

- A late or retried cancel could stop the next turn.
- A cancellation whose provider reply failed late could fail the next turn.
- A full disk blocked cancellation.

The blockers are these:

- **R001 and R002:** 21 of the 71 effect commands take no operation ID, and
  23 more are covered only in part or not at all.
- **R003:** stream fencing is not covered.
- **R004:** a cancel shares the socket backlog with ordinary commands, so a
  connection flood can refuse it.

## Effect command coverage matrix

`packages/contracts` declares 120 queries, 71 idempotent commands and 71
effect commands. Every row below is an effect command. Criteria come from
`13-reliability/spec.md`:

- **R002:** the same ID and payload returns the recorded result. The same ID
  with an altered payload is a strict conflict. Both hold after a daemon
  restart.
- **R001:** a crash between admission and settlement leaves a recorded
  outcome or an explicit unknown. Reconciliation never replays blindly.

The ID column shows how a request is identified:

- `op` is a required `operation_id`.
- `req` is the `request_id` that serves as the send identity.
- `opt` is an optional `operation_id`.
- `none` means the request carries no ID.

The coverage columns use these marks:

- **pass (this slice):** proven here in `reliability-a/receipts.spec.ts`.
  R002 covers the replay, the conflict, both again after a daemon SIGKILL,
  and a single effect. R001 covers a lost reply with a daemon SIGKILL at once
  and after the effect. For Git-worker commands, it also covers a SIGKILL
  while the worker holds the dispatched command.
- **pass (cited):** proven by an earlier round's spec that is named here.
  This slice read the spec titles and assertions but did not rerun it.
- **partial:** some part of the criterion is missing, as stated in the row.
- **gap:** the contract has no operation ID. The fixme is in
  `reliability-a/operation-ids.spec.ts`.
- **not covered:** no protocol E2E exercises the operation.

| Operation | ID | R002 | R001 |
|---|---|---|---|
| agent.send | req | pass (cited): `conversations/send-queue.spec.ts` same request ID | pass (cited): `send-queue.spec.ts` lost reply and kill, runtime crash; `conversations2/lost-turn.spec.ts` |
| agent.answer | req | pass (cited): `conversations/requests.spec.ts` one answer, conflict across restart | pass (cited): `requests.spec.ts` failpoints before and after delivery |
| conversation.create | none | gap | gap |
| queue.enqueue | req | pass (cited): `conversations2/queue.spec.ts` | pass (cited): `conversations2/queue.spec.ts` lost reply and SIGKILL |
| queue.pause | none | gap | gap |
| conversation.steer | op | pass (cited): `conversations/controls.spec.ts` | pass (cited): `controls.spec.ts` lost reply and kill |
| conversation.compact | op | pass (cited): `conversations2/compact.spec.ts` | pass (cited): `compact.spec.ts` lost reply, crash before provider acknowledgement, runtime loss (unknown) |
| conversation.rewind | op | pass (cited): `conversations2/rewind-create.spec.ts` | pass (cited): `rewind-create.spec.ts`, `context/rewind.spec.ts` |
| agent.cancel | none | gap (R003 fence added: `turn_id`) | gap |
| agent.resume | none | gap | gap |
| agent.disconnect | none | gap | gap |
| agent.send_review | req | not covered | not covered |
| account.create | none | gap | gap |
| account.switch | op | pass (cited): `providers/account-switch.spec.ts` | pass (cited): same test, lost reply and SIGKILL |
| terminal.create | opt | pass (this slice); also `terminals/create.spec.ts` | pass (this slice) |
| terminal.restart, terminal.stop, terminal.retire | none | gap | gap |
| service.start, service.stop, service.remove | none | gap | gap |
| service.proxy.remap, service.proxy.retire, service.proxy.recovery.retry, service.proxy.recovery.reset | none | gap | gap |
| review.stage, review.unstage, review.commit, review.discard, review.hunk | op | pass (this slice) | pass (this slice), including the held worker: `interrupted`, listed until acknowledged, never rerun |
| worktree.create, worktree.remove, worktree.switch | op | pass (this slice) | pass (this slice), including the held worker |
| worktree.adopt | none | gap | gap |
| worktree.refresh, worktree.setup, worktree.cleanup, worktree.resources.apply | op | partial: `worktrees/lifecycle.spec.ts` and `worktrees/resources.spec.ts` replay and conflict with no restart | partial: only `worktree.setup` has a daemon crash (`lifecycle.spec.ts`, interrupted setup) |
| worktree.carry | op | partial: `worktrees/carry.spec.ts` conflict before restart, replay after SIGKILL | not covered |
| script.start, script.stop, script.retire | none | gap | gap |
| runtime.prepare_restart | none | gap (fenced by `boot_id`, no receipt) | gap |
| browser.open, browser.navigate, browser.close, browser.click, browser.type | op | not covered: the browser owner is Electron, and Electron E2E is paused | not covered |
| skill.install, skill.remove | op | pass (this slice); also `catalogs/skills.spec.ts` | pass (this slice) |
| skill.adopt | op | partial: `catalogs/skills.spec.ts` concurrent duplicates, no restart | not covered |
| plugin.install, plugin.uninstall | op | partial: `plugins/lifecycle.spec.ts` replay and `code: conflict`, no replay after restart | not covered |
| plugin.command.invoke | op | partial: `plugins/host.spec.ts` replay and conflict, no restart | not covered |
| orchestration.delegate, orchestration.child.send | op | pass (cited): `orchestration/delegation.spec.ts` conflict; replays survive restart and crash | not covered: no crash between admission and settlement |
| orchestration.group.start | op | pass (cited): `orchestration/parallel-runs.spec.ts` dedupe, conflict, SIGKILL | not covered |
| resources.claim.resolve, resources.registry.accept | op | partial: `resources/host-resources.spec.ts` replay and conflict, no restart | not covered |
| checkpoint.create, checkpoint.delete, checkpoint.restore | op | pass (this slice) | pass (this slice); a restore counts one safety checkpoint per execution |
| remote.host.start | op | pass (cited): `remote/bootstrap.spec.ts` replay and conflict | pass (cited): `bootstrap.spec.ts` start interrupted by a local daemon crash is not replayed |
| remote.host.install | op | partial: `remote/bootstrap.spec.ts`, no conflict or restart check | not covered |
| repository.clone | op | pass (this slice) | pass (this slice): an interrupted clone reports "nothing changed" and is not rerun |
| repository.publish | op | not covered | pass (cited): `resources/repository.spec.ts` daemon killed during push is unknown; the typed code is `fixme` there |
| hook.delivery.retry | op | not covered | partial: `plugins/hooks.spec.ts` covers the delivery, not the retry command |
| device.boot, device.app.install, device.app.launch | op | pass (cited): `devices/ios.spec.ts` | pass (cited): `ios.spec.ts` lost reply, interrupted boot and install, unobservable launch |
| command.invoke | op | pass (cited): `context/commands.spec.ts` | pass (cited): `commands.spec.ts` lost reply and SIGKILL |

The matrix totals:

- 21 effect commands have no ID (gap).
- 15 pass R002 and R001 in this slice.
- 12 pass both through cited specs.
- 23 are partial or not covered.

## Acceptance criteria

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| R002 | Same ID and payload replays; altered payload conflicts; both after daemon SIGKILL; effect once (15 effect commands) | `receipts.spec.ts` "R002: ... replays one ID and refuses it for another payload, also after a daemon crash" | pass |
| R002 | Every effect command carries an operation ID | `operation-ids.spec.ts` (21 ops) | fixme (gap) |
| R001 | Lost reply, daemon SIGKILL at once (usually before admission) and after the effect: retry returns the recorded outcome or explicit unknown, never a second effect (15 commands) | `receipts.spec.ts` "R001: ... with a lost reply and a daemon crash at once / after the effect runs once" | pass |
| R001 | SIGKILL while a Git worker holds a dispatched command: retry reports `interrupted` (unknown); it is listed until acknowledged and never rerun (5 review and 3 worktree commands) | `receipts.spec.ts` "R001: ... dispatched to a Git worker when the daemon crashes" | pass |
| R001 | Crash between provider acknowledgement and settlement for every provider-facing effect | cited for conversation and device commands only | partial |
| R003 | A cancel naming the previous turn is refused and never stops its successor (SDK and CLI `--turn`, also after a daemon SIGKILL) | `cancel-fencing.spec.ts` "a cancel that names the previous turn is refused" | pass (failed before fix 1: no field to fence on) |
| R003 | Cancel raced against admission of the next turn stops only its own turn | `cancel-fencing.spec.ts` "a cancel racing the admission of the next turn" | pass |
| R003 | Async callback: a cancellation whose provider reply fails after its turn ended does not fail the successor | `cancel-fencing.spec.ts` "a cancellation whose provider reply fails after the turn ended" | pass (failed before fix 2) |
| R003 | Async callback: a late `turn/start` reply or error for a finished turn neither fails nor replaces the successor | `cancel-fencing.spec.ts` "a late provider reply to a finished turn" | pass |
| R003 | Stream fencing: events of an old run or incarnation cannot reach a successor | none; no fixture can deliver an old run's stream after a new run starts | not covered |
| R004 | Data volume full (disposable 48 MiB HFS+ image): new send refused through SDK and CLI with nothing reaching the provider; cancel still interrupts the provider and either records `cancelling` (ack) or reports it could not record; recovery after space returns | `overload.spec.ts` "with the data volume full" | pass (failed before fix 3; see the overload follow-up for fix 4 and the either-outcome check) |
| R004 | About 40 MiB of provider output plus 400 concurrent ordinary commands: cancel stops the turn; no sent command is lost | `overload.spec.ts` "an output flood and a burst of ordinary commands" | pass (cancel retried only while `not_sent`) |
| R004 | A cancel during a connection flood past the socket backlog is admitted on its first attempt | `overload.spec.ts` fixme | fixme (gap; refused in 1 of 3 runs when enabled) |
| R004 | Saturated ordinary receipts: cancel admitted from the reserve | `recovery/receipt-saturation.spec.ts` (round 1) | pass (cited) |

## Product fixes

1. **A late or retried cancel stopped the successor turn.** `agent.cancel`
   named only the Conversation.
   - `AgentCancelRequest` gains an optional `turn_id` in
     `crates/ade-core/src/contract/agents.rs`.
   - The daemon refuses a cancel whose turn is no longer active. The error is
     "Turn … is no longer active; nothing was cancelled". The pure decider is
     `cancel_refusal`, in `crates/ade-daemon/src/sessions/agents.rs`.
   - The CLI gains `conversation cancel ID --turn TURN_ID`.
   - A cancel without `turn_id` behaves as before.
2. **A cancellation that failed late failed the successor turn.**
   - The runtime journaled every failed Agent command except `answer`,
     `steer` and `compact` as `OperationFailed` with no submission. The daemon
     then failed the whole run, including a turn started after the cancel.
   - A failed `cancel` no longer ends the run: `failure_ends_run` in
     `crates/ade-runtime/src/agent_runtime.rs`.
   - The daemon's cancel callback is now fenced by the cancelled submission:
     `fail_if` with the submission.
3. **A full disk blocked cancellation.** `cancel` returned the SQLite error
   before it sent the interrupt.
   - It now always asks the provider to stop.
   - When it cannot record `cancelling`, it replies with an error that says so
     and names the storage error.
   - The Conversation reconciles to `interrupted` once writes succeed.

In-process tests for the pure cores:
`a_cancel_naming_an_earlier_turn_never_stops_its_successor` (daemon) and
`a_failed_cancel_never_fails_the_run_it_shares_with_a_successor` (runtime).

4. **A full disk failed the running Agent** (overload follow-up, after the
   round 3 merge). A provider event batch that arrived after the volume
   filled could not be recorded. The event loop then failed the Agent, so
   `agent.cancel` replied "Agent is not connected" and nothing reconciled the
   Conversation, which still read `running`.
   - `events` now returns `StorageFull` when SQLite reports `SQLITE_FULL`.
     The event loop keeps the Agent, leaves the batch unacknowledged and
     retries it every 250 ms. It logs once per wait.
   - The runtime serves the unacknowledged batch again, the same replay path
     a daemon restart uses. Ingest is idempotent: the cursor, message IDs and
     the usage replay cursor skip what was already committed.
   - Code: `crates/ade-daemon/src/sessions/agents.rs`.

## Overload follow-up (round 4)

Status: returned. Branch: `claude/wf_c51346dc-a4d-4`.

The failure after the round 3 merge was not a swallowed error. `cancel`
still bails when `commit_conversation` fails. The commit simply succeeded:

- The database runs in WAL mode with `synchronous=FULL`.
- A refused insert can leave allocated WAL space, and a checkpoint lets the
  WAL restart in place. The cancellation's small in-place update of one
  Conversation row can then commit durably while a new Conversation cannot.
- Which one happens depends on page layout. No merged change caused it
  directly; the round 3 schema and write changes moved the layout.

Decision:

- An ack is correct when the cancellation was recorded. R004 asks that stop
  "remains available or reports its actual failure". R001 asks that an
  accepted operation is kept. Reporting "could not record" after a durable
  commit would be false.
- The spec now accepts either outcome and checks each one. After an ack,
  `conversation.get` reads `cancelling` or `interrupted`. After a refusal,
  the reply names "could not record the cancellation" and the storage error.
  In both cases, the provider receives exactly one interrupt, and the
  Conversation reaches `interrupted` after space returns.
- The spec records which branch ran in a `cancel-while-full` annotation.

Reproducing it also exposed fix 4 above: in 1 of 2 runs, the Agent was
failed during the fill, and cancel replied "Agent is not connected".

Checks in this follow-up (all run serially; no other hdiutil run was active):

- `ADE_E2E_SYSTEM=1 ADE_E2E_WORKERS=1 pnpm test:e2e:protocol:only
  e2e/protocol/reliability-a/overload.spec.ts`: 2 passed and 1 fixme, twice.
- The full-volume test alone, four more times on the fixed build: 4 passed.
  Three runs took the ack branch and one took the refusal branch.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/reliability-a
  e2e/protocol/conversations e2e/protocol/recovery`: 122 passed and 25
  skipped (fixme and system-service specs).
- `pnpm check:static`: pass, with 770 legacy Rust tests passed and 5 skipped.
- After the runs, `mount` showed no scratch volume, and `pgrep` found no
  `ade-daemon`, `ade-runtime`, `hdiutil` or `security` process from this
  worktree.
- No keychain, Security framework or `security` tool was used.

What is uncertain:

- No spec forces an event batch to arrive while the volume is full, so fix 4
  is proven only by the runs that happened to hit it. The spec no longer
  fails when they do.
- A retried batch repeats side effects taken before its commit, such as
  rejecting an unsupported provider request. A daemon restart replays the
  same way.

Time: implementation 25, review 5, checks 20, integration 0 (minutes).

## Operation tiers

`agent.cancel` (effect command) gains the optional `turn_id` field. No
operation was added and no tier changed.

## New generic fixtures

- `e2e/protocol/fixtures/codex_cancel_faults.py`: a Codex mock proxy.
  - While `hold-interrupt-reply` exists, it forwards `turn/interrupt` but
    withholds the reply.
  - At `release-interrupt`, it answers the interrupt with an error.
- `e2e/protocol/fixtures/scratch-volume.ts`: `ScratchVolume` and
  `volumeTest`.
  - It makes a disposable hdiutil disk image, mounts it at a chosen path, and
    fills and frees it.
  - Its fixture stops the registered profile before it detaches the image.
- Neither is re-exported from `fixtures/index.ts`.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/reliability-a`:
  59 passed and 22 fixme. Under `--repeat-each 2`, every non-fixme test
  passed. The disk-full, clone and flood tests also passed under
  `--repeat-each 3`.
- Pre-fix build:
  - "a cancellation whose provider reply fails" failed, because the steer was
    `unavailable`: the successor had been failed.
  - With a full disk, cancel returned "database or disk is full" and no
    interrupt reached the provider.
- Regression run on the fixed build:
  - `conversations`, `conversations2`, `recovery`, `orchestration`,
    `adapters` and `boot.spec.ts` ran: 107 passed and 3 fixme.
- `pnpm check:static`: pass, with 759 legacy Rust tests passed and 5 skipped.
- `pgrep` found no `ade-daemon` or `ade-runtime` from this worktree after the
  runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 110 | 10 | 35 | 0 |

## References

- `docs/proposed-architecture.md` section 4 (tiers, receipts, fencing,
  reserved capacity, failure contract).
- `scripts/test_sessions.py` (legacy, unmaintained): the `late-error` and
  `hold-late` mock prompts, studied and re-expressed as protocol E2E.
- `.scratch/ade-v1/evidence/e2e-conversations.md`, `e2e-conversations2.md`
  and `e2e-recovery.md`: prior R001, R002 and R004 claims, checked against
  their specs.
- No external code was copied.

## Open

- **Gap (21 fixme):** these effect commands take no operation ID:
  - `conversation.create`, `queue.pause`, `agent.cancel`, `agent.resume` and
    `agent.disconnect`;
  - `account.create`;
  - `terminal.restart`, `terminal.stop` and `terminal.retire`;
  - `service.start`, `service.stop`, `service.remove` and the four
    `service.proxy.*` commands;
  - `worktree.adopt`;
  - `script.start`, `script.stop` and `script.retire`;
  - `runtime.prepare_restart`.

  Each needs a contract field and a receipt in its owning domain. Until then
  R001 and R002 cannot be accepted.
- **Gap (fixme):** cancellation has no reserved control lane at the socket.
  The profile socket's listen backlog (128 on macOS) is shared with ordinary
  commands. A connection flood refuses a cancel with ECONNREFUSED. The cancel
  was `not_sent`, so a retry is safe.
- **Not covered:**
  - R003 stream fencing;
  - `agent.send_review`, `repository.publish` (R002), the browser commands
    (Electron-owned) and `hook.delivery.retry`;
  - R001 for the partial rows in the matrix.
- **Possible outside bug, not fixed:** `repository.clone` interrupted by a
  daemon crash reports "Clone was interrupted before it wrote anything;
  nothing changed" but refuses the same ID forever. The spec accepts this
  (no blind replay). A retry path for a known-empty outcome may be wanted.
- **Coordinator:** the contract change regenerated
  `packages/contracts/{schema/contracts.json,src/generated/*}`.
