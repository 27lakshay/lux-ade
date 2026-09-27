# E2E round 5: reliability-core

Status: returned
Type: slice evidence
Branch: claude/wf_59b7ac6e-d6c-1; follow-up `claude/wf_ead686db-a2b-1` (resources-receipts)
Worker: ADE parallel build, reliability-core worker
Requirements: R001, R002, R003

## Follow-up: resources-receipts (review blocker from round 4)

The blocker: `resources.claim.resolve` and `resources.registry.accept`
committed their effect with the receipt `acknowledged`, then recorded the reply
as `settled` in a separate write. A crash between the two left the receipt
open forever, and every retry answered with the registry as it read at that
moment, never a settled reply or an explicit unknown.

What is uncertain, before what changed:

- **The legacy `acknowledged` path of `resources.claim.resolve` has no spec.**
  This build never leaves that receipt open, so only a database written by an
  earlier build reaches it. The code settles it on its first retry, the same
  way as `resources.registry.accept`, which the spec does prove.
- **`resources.registry.accept` still writes twice.** Its reply includes the
  claims re-taken in the new registry, a separate SQLite file from the profile
  database that holds the receipt, so one transaction cannot cover both.
  Instead the first retry of an `acknowledged` receipt settles it (below).
- The accept handler now holds the worktree data lock until the reply is
  recorded, so a concurrent retry of the same ID cannot settle first. That lock
  already covered the re-claims, so the lock order (data, then registry) is
  unchanged.

Changes:

1. **`resources.claim.resolve` records its reply in the same transaction as
   the claim's removal** (`HostResources::resolve_claim`). The reply is built
   from the uncommitted transaction (`state_in`), so it is exactly the state
   the commit produces. A retry replays it or finds nothing done.
2. **`resources.registry.accept` settles on its first `acknowledged` replay**
   (`HostResources::accept`): the binding is known to have committed, so the
   retry records the registry as it reads now as the settled reply and
   returns it; every later retry replays that. An open receipt in any other
   state answers "outcome is unknown and it will not run again".
3. **A debug-only pause point**, `receipts::e2e_pause(point)`, gated by
   `ADE_E2E_RECEIPT_PAUSE_DIR` and compiled out of release builds. With
   `<point>.armed` in that directory the daemon writes `<point>.paused` and
   waits up to 30 s for `<point>.release`. It sits after the resolve commit and
   between the accept's two writes (`worktrees.rs`, `resources_command`).
4. **Other `receipts.rs` callers checked.** The remaining callers that write
   `acknowledged` (`review.rs` backup record, `sessions/checkpoints.rs`
   restore, `sessions/repository.rs` clone and publish) use it as a phase
   marker *before* the effect, and their replay paths reconcile it from disk
   or mark it unknown (`interrupt_open_receipts`, `checkpoint_reconcile`,
   `repository_reconcile`). `controls.rs` and `commands.rs` read it only.
   `hooks.rs`, `skills.rs`, `plugins.rs` and `envelope.rs` settle in the
   effect's transaction or reconcile open receipts on open. None has the split.

Spec: `e2e/protocol/reliability-core/reply-record.spec.ts`, one test per
command. It arms the pause, sends the command and drops the reply, SIGKILLs the
daemon at the pause, restarts, retries, SIGKILLs again, and retries once more.
Both retries must return the same reply (each daemon names its own incarnation
in a reply read "as it reads now", so an unsettled replay differs), the effect
applies once, and an altered payload is a conflict. With the accept's
`acknowledged` reconciliation disabled, the spec fails on the second retry;
with it, it passes 3 of 3 under `--repeat-each 3`.

Checks for the follow-up:

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/reliability-core e2e/protocol/resources`:
  207 passed, 0 failed.
- `pnpm check:static`: pass; 798 legacy Rust tests run, 798 passed, 5 skipped.
- `pgrep` after the runs: no `ade-daemon`, `ade-runtime` or `security`
  process from this worktree. No keychain, Security framework, `security` tool
  or hdiutil was used.

Time (minutes): implementation 35, review 10, checks 15, integration 0.

## Outcome

Every one of the 81 effect commands in `packages/contracts` now has a passing
headless spec for R001 and R002, and R003 has passing specs for commands,
async callbacks and streams. The specs exposed seven product gaps, all fixed
(see "Product fixes"). Nothing in `e2e/protocol/reliability-core/` is
`test.fixme`.

What is uncertain, before what went well:

- **Reconciliation is automatic for some commands only.** For 17 of the 21
  commands the new envelope keeps, an interrupted command whose handler may
  have acted stays `outcome_unknown` until the state proves it. The daemon
  lists it in `diagnostics.status` at once and never reruns it, but only
  `terminal.stop`, `terminal.retire`, `queue.pause` and `agent.disconnect`
  have an observer that settles it from the current state. The others need
  the person to inspect and send a new operation ID.
- **Disk-full cancellation through the envelope is proven in-process only.**
  A stop command (`agent.cancel`, `terminal.stop`, `service.stop`,
  `script.stop`) runs without a receipt when the receipt cannot be written.
  The pure test proves it; the disk-image spec in `reliability-a/overload.spec.ts`
  needs `ADE_E2E_SYSTEM=1` and hdiutil, which this slice did not run.
- **Cited specs.** 22 commands are proven by specs other slices wrote (the
  "cited" rows). This slice did not rewrite them. They ran and passed in this
  slice's full protocol run on this build.
- `e2e-conversation-fixes.md`, named in the task, does not exist in the
  repository. `e2e-conversations2.md` was read in its place.

## Criteria

From `13-reliability/spec.md`:

- **R001:** crash around intent commit, dispatch, external acknowledgement
  and settlement; return recorded outcomes or explicit unknown status and
  reconcile without blind replay.
- **R002:** retry identical operation IDs and payloads, then altered
  payloads; observe deduplication and strict conflict even after reconnect.
- **R003:** race cancel, cleanup and a new admitted wake or turn; verify
  incarnation fencing on commands, async callbacks and streams.

## Effect command matrix

Each SDK call opens a new connection, so every replay is also a reconnect.
"Restart" means a daemon SIGKILL and a new daemon on the same data.

Marks:

- **core-env:** `reliability-core/envelope.spec.ts`. R002: same ID replays the
  recorded reply with the effect applied once (a `reset` under another ID
  shows a rerun would be visible), one altered field is a `conflict`, both
  again after restart. R001: SIGKILL at three points (intent committed, dispatch
  recorded before the handler, handler done before settlement). The retry
  reports `not_applied`, `outcome_unknown` or the reconciled reply, the effect
  never runs twice, `diagnostics.status` lists the unknown before any retry.
- **core-rcpt:** `reliability-core/receipts.spec.ts` over `domain-cases.ts`,
  the checks `reliability-a/receipts.spec.ts` applies: R002 replay, conflict,
  both after restart, effect once; R001 lost reply with SIGKILL at once and
  after the effect; for worker-settled commands also SIGKILL while the worker
  holds the dispatched command (reported `interrupted`, never rerun).
- **rel-a:** `reliability-a/receipts.spec.ts` (round 3), same checks.
- **cited:** the named spec from an earlier round.

| Operation | ID | R002 | R001 |
|---|---|---|---|
| agent.send | request_id | cited `conversations/send-queue.spec.ts` | cited `send-queue.spec.ts`, `conversations2/lost-turn.spec.ts` |
| agent.answer | request_id | cited `conversations/requests.spec.ts` | cited `requests.spec.ts` failpoints before and after delivery |
| conversation.create | op (new) | core-env | core-env |
| queue.enqueue | request_id | cited `conversations2/queue.spec.ts` | cited `conversations2/queue.spec.ts` |
| queue.pause | op (new) | core-env | core-env (reconciled) |
| conversation.steer | op | cited `conversations/controls.spec.ts` | cited `controls.spec.ts` |
| conversation.compact | op | cited `conversations2/compact.spec.ts` | cited `compact.spec.ts` |
| conversation.rewind | op | cited `conversations2/rewind-create.spec.ts` | cited `rewind-create.spec.ts`, `context/rewind.spec.ts` |
| agent.cancel | op (new) | core-env | core-env |
| agent.resume | op (new) | core-env | core-env |
| agent.disconnect | op (new) | core-env | core-env (reconciled) |
| agent.send_review | request_id | core-rcpt | core-rcpt |
| account.create | op (new) | core-env | core-env |
| account.switch | op | cited `providers/account-switch.spec.ts` | cited, same test |
| terminal.create | op (optional) | rel-a | rel-a |
| terminal.restart | op (new) | core-env | core-env |
| terminal.stop | op (new) | core-env | core-env (reconciled) |
| terminal.retire | op (new) | core-env | core-env (reconciled) |
| service.start, service.stop, service.remove | op (new) | core-env | core-env |
| service.proxy.remap, .retire, .recovery.retry, .recovery.reset | op (new) | core-env | core-env |
| review.hunk, .stage, .unstage, .discard, .commit | op | rel-a | rel-a, with the held worker |
| review.branch, .stash, .merge, .fetch, .pull, .push | op | core-rcpt | core-rcpt, with the held worker |
| worktree.create, .remove, .switch | op | rel-a | rel-a, with the held worker |
| worktree.adopt | op (new) | core-env | core-env |
| worktree.refresh, .setup, .cleanup, .carry, .resources.apply | op | core-rcpt | core-rcpt, with the held worker |
| script.start, script.stop, script.retire | op (new) | core-env | core-env |
| runtime.prepare_restart | op (new) | `reliability-core/restart.spec.ts`: the next daemon replays the recorded handover and keeps serving | `restart.spec.ts`: SIGKILL at the three envelope points |
| browser.open, .navigate, .close, .click, .type | op | `reliability-core/browser.spec.ts`: replay with no second relay to the owner, conflict, both after restart before any owner registers | `browser.spec.ts`: SIGKILL while the owner holds the command; unknown, never relayed again, then reconciled by `browser.operation` |
| skill.install, skill.remove | op | rel-a | rel-a |
| skill.adopt, skill.place | op | core-rcpt | core-rcpt |
| plugin.install, plugin.uninstall | op | core-rcpt | core-rcpt |
| plugin.command.invoke | op | core-rcpt | core-rcpt; `reliability-core/extras.spec.ts`: SIGKILL while the host holds the command, `outcome_unknown`, never started again |
| orchestration.delegate, .child.send, .parent.send, .group.start | op | core-rcpt | core-rcpt |
| orchestration.child.answer | native request_id | `extras.spec.ts`: converges after restart, other answer refused, one reply | `extras.spec.ts`: lost reply and SIGKILL, one reply |
| resources.claim.resolve, resources.registry.accept | op | core-rcpt | core-rcpt; `reliability-core/reply-record.spec.ts`: SIGKILL after the effect commits and before the reply is final, then two retries with a SIGKILL between them return one settled reply |
| checkpoint.create, .restore, .delete | op | rel-a | rel-a |
| remote.host.start | op | cited `remote/bootstrap.spec.ts` | cited `bootstrap.spec.ts` |
| remote.host.install | op | `reliability-core/remote.spec.ts`: replay, conflict, both after restart, no second upload | `remote.spec.ts`: SIGKILL while the host holds the install, `unknown`, nothing sent again |
| repository.clone | op | rel-a | rel-a |
| repository.publish | op | core-rcpt | core-rcpt; cited `resources/repository.spec.ts` (push killed) |
| hook.delivery.retry | op | core-rcpt | core-rcpt |
| device.boot, .app.install, .app.launch | op | cited `devices/ios.spec.ts` | cited `ios.spec.ts` |
| device.input | op | `extras.spec.ts` after restart; cited `devplug/device-input.spec.ts` | cited `device-input.spec.ts` (crash is unknown, never resent) |
| command.invoke | op | cited `context/commands.spec.ts` | cited `commands.spec.ts` |

"op (new)" marks the 21 commands that had no operation ID before this slice.

## R003 criteria

| Criterion part | Spec | Result |
|---|---|---|
| Commands: a cancel naming the previous turn never stops the successor, also after restart | cited `reliability-a/cancel-fencing.spec.ts` | pass |
| Commands: a retried cancel replays its receipt (now an effect command with an ID) | `envelope.spec.ts` › agent.cancel | pass |
| Async callbacks: a late cancel failure and a late `turn/start` reply do not touch the successor | cited `cancel-fencing.spec.ts` | pass |
| Streams: after the successor starts, the cancelled turn's late delta, message, error, question and failed completion never reach it; the text stays the old turn's; the question is refused on the pipe | `reliability-core/stream-fencing.spec.ts` › a new send | pass after fix 5 |
| Streams across an incarnation change: the same with a daemon SIGKILL between the cancel and the successor | `stream-fencing.spec.ts` › after a daemon crash | pass after fix 5 |
| Race cancel, cleanup and a new wake: a queued prompt woken by resuming the queue while the cancelled turn still ends runs once as the successor, fenced the same way | `stream-fencing.spec.ts` › a queued wake | pass after fix 6 |

## Product fixes

1. **21 effect commands took no operation ID.** Their contracts now require
   `operation_id`. The daemon keeps their receipts in a new envelope,
   `crates/ade-daemon/src/envelope.rs`, in its own receipt store
   `sessions.envelope.sqlite3` (a first version shared `sessions.sqlite` on a
   second connection and made the profile store fail with "database is locked";
   the full run caught it). Retention and diagnostics read it with the other
   receipt stores. Each command is accepted, then dispatched, then settled
   with the reply or error. A retry replays; another payload is `conflict`. A receipt
   an earlier daemon left open is settled when the daemon opens: `not_applied`
   if it was never dispatched, `outcome_unknown` if it was. Four commands have
   an observer that settles an unknown from the current state. Stop commands
   still run when the receipt cannot be written.
   - The SDK's `call()` and `dailyUseCommand()` fill a fresh `operation_id`
     when the caller leaves it out, and name it on any error
     (`DaemonRequestError.operationId`). The generator emits the list as
     `operationIdOperations`. The remote transport's `command()` does the same.
   - The CLI takes a global `--operation-id ID` before the command and names
     the ID it sent in its error JSON.
   - The desktop main process and the control binary send an ID.
2. **Browser receipts were in memory.** After a daemon restart a retried
   browser command reached the owner again. They are now in
   `<data>/browser-operations.sqlite3`; a mutation an earlier daemon
   dispatched opens as unknown, and `browser.operation` reconciles it.
3. **`resources.claim.resolve` and `resources.registry.accept` replayed the
   registry as it reads now,** not the recorded reply; after a restart the
   replay differed. They now record and replay the reply.
4. **`resources.registry.accept` validated the payload before the receipt,**
   so a reused ID with another path gave a validation error instead of a
   conflict. The receipt is now read first.
5. **A cancelled turn's late provider error landed on its successor**
   (`conversation.error` set while the new turn ran). Provider errors now
   carry the turn they name (`Event::Error.turn`, optional); the daemon drops
   an error for a turn other than the active one.
6. **A wake received while the cancelled turn ended was lost.** Resuming the
   queue during `cancelling` was undone when the interruption settled, which
   paused the queue again; the queued prompt never ran. The Conversation
   records the turn during which the queue was resumed
   (`queue_resumed_during`), and that turn's end no longer re-pauses it.
7. **`terminal.create` failed with "database is locked" under load.** It
   read, then wrote, in a deferred transaction; when another connection to
   the profile database (history, usage) committed in between, SQLite refused
   at once. It now takes the store's immediate transaction and waits. Seen
   once per full run as a setup failure; not seen in 3 repeats after the fix.

## Operation tiers

No operation was added and no tier changed. Contract changes:

- Effect commands gain a required `operation_id`: `conversation.create`,
  `queue.pause`, `agent.cancel`, `agent.resume`, `agent.disconnect`,
  `account.create`, `terminal.restart`, `terminal.stop`, `terminal.retire`,
  `service.start`, `service.stop`, `service.remove`, `service.proxy.remap`,
  `service.proxy.retire`, `service.proxy.recovery.retry`,
  `service.proxy.recovery.reset`, `worktree.adopt`, `script.start`,
  `script.stop`, `script.retire`, `runtime.prepare_restart`.
- `Conversation` gains optional `queue_resumed_during`.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/reliability-core`:
  190 tests in 8 files, all pass; none is `test.fixme`.
- Full protocol suite, `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only`, run
  three times on this branch:
  - Run 1: 725 passed, 11 failed. The failures were my own: 7 remote specs
    whose SDK transport did not fill `operation_id`, 3 "database is locked"
    from the envelope's shared connection, 1 `files-git/local-git.spec.ts`
    merge-abort timeout. All fixed except the last, which passed on rerun.
  - Run 2: 736 passed, 1 failed ("database is locked" in `terminal.create`,
    fix 7).
  - Run 3 (final build): 737 passed, 0 failed, 31 skipped (fixmes and
    `ADE_E2E_SYSTEM` specs).
- `stream-fencing.spec.ts` under `--repeat-each 3`: 9 passed. Before fix 6 the
  queued-wake case failed 3 of 3; before fix 5 the send cases failed 2 of 2.
- `pnpm check:static`: pass, with 798 legacy Rust tests run, 798 passed and
  5 skipped.
- `node --test packages/client/src/call.test.mjs`: 8 passed.
- `pgrep` found no `ade-daemon`, `ade-runtime` or `security` process after the
  runs. No keychain, Security framework, `security` tool or hdiutil was used.

## In-process tests added

- `crates/ade-daemon/src/envelope.rs`: replay, conflict, missing ID, replay by
  step, recovery on open, reconciliation, stop without a receipt.
- `crates/ade-daemon/src/receipts.rs`: `only_a_settled_whole_reply_is_replayed`.
- `crates/ade-daemon/src/bin/daemon/server.rs`:
  `a_browser_mutation_dispatched_by_an_earlier_daemon_opens_as_unknown`.
- `crates/ade-daemon/src/sessions/agents.rs`:
  `a_late_event_of_another_turn_is_fenced_from_the_active_one`,
  `a_wake_received_while_the_cancelled_turn_ends_is_kept`.
- `crates/ade-runtime/src/codex.rs`: `a_provider_error_keeps_the_turn_it_names`.
- `packages/client/src/call.test.mjs`: operation ID fill and naming.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 240 | 20 | 90 | 0 |

## References

- `docs/proposed-architecture.md` section 4 (tiers, receipts, reconciliation,
  incarnation fencing, reserved capacity).
- `.scratch/ade-v1/evidence/e2e-reliability-a.md`, `e2e-conversations.md`,
  `e2e-conversations2.md`: prior matrix and claims, checked against the specs.
- `e2e/specs/review-feedback-batch.spec.ts` (legacy), studied: the review
  anchor shape for `agent.send_review`.
- No external code was copied.

## Open

- **Coordinator, shared files:** the contract change regenerated
  `packages/contracts/{schema/contracts.json,src/generated/*}` and changed
  `scripts/generate-contracts.mjs` (new `operationIdOperations` export). A slice
  merged after this one that sends one of the 21 commands over a raw protocol
  line must add `operation_id`; SDK and `profile.call` callers need nothing.
- **Other areas' specs edited** only to add an `operation_id` to raw protocol
  lines, with no assertion changed: `conversations2/queue.spec.ts`,
  `services/scripts.spec.ts`, `services/faults.spec.ts`,
  `services/ports.spec.ts`, `remote2/stability.spec.ts`, and the fixtures
  `profile.ts`, `managed-profiles.ts`, `remote-hosts.ts`, `e2e/fixtures/daemon.ts`.
- **Fixmes elsewhere that now pass or are obsolete,** left for their owners:
  `reliability-a/operation-ids.spec.ts` (21 fixmes; the contracts now require
  `operation_id`), `conversations2/rewind-create.spec.ts` (create under one ID).
  `services/faults.spec.ts` "returns its receipt" expects a `receipt` field in
  the reply, which this design does not add; the replay itself is proven here.
- **Legacy Electron specs** (`e2e/specs/*`, paused) send about 200 raw lines for
  the 21 commands without an `operation_id`; they will need one when Electron
  E2E resumes. `e2e/fixtures/daemon.ts` restart already sends one.
- **Backups:** the backup format (`bin/control/backup/coverage.rs`) does not
  copy `sessions.envelope.sqlite3` or `browser-operations.sqlite3`. After a
  restore, a retry of an ID recorded only there would run as new work. Adding
  them needs a backup format bump; that belongs to the backup owner.
- **Not fenced:** a stale `turn/started` for an old turn would still become the
  active turn. No provider sends one after a later turn starts, so no spec
  drives it.
