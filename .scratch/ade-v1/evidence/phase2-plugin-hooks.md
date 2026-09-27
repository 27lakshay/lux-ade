# phase2-plugin-hooks

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-4
Worker: Phase 2 round D workflow, slice plugin-hooks
Requirements: F058 (backend outbox and operations, advanced, not accepted)

## Outcome

The daemon now has a durable lifecycle hook outbox. A plugin subscribes in its
manifest with `contributes.hooks`. When a hookable event commits, the same
transaction writes one delivery per subscribed plugin. A dispatcher thread
hands each delivery to a plugin host with a stable effect ID. No backend plugin
host exists yet, so every delivery waits in `awaiting_host`, and
`hook.delivery.list` reports why.

Hookable events and where they commit:

| Event | Committed by | Database |
|---|---|---|
| `turn.settled` (`completed`, `interrupted`, `failed`, `unknown`) | `commit_conversation`, and `recover_except` for turns a restart lost | profile state |
| `workspace.created` | `workspace_open`, for a new record only | profile state |
| `service.state_changed` (`starting`, `stopped`) | `reserve_service`, `release_service` | profile state |
| `worktree.created`, `worktree.removed` | the worktree job's completion transaction, when it succeeded | worktree lifecycle |

The profile state database holds the outbox. The worktree lifecycle database
stages its deliveries in the same tables in its own commit. The dispatcher then
relays them into the outbox and deletes a staged row only after the outbox
holds it. Effect IDs are deterministic (plugin, event and source key), so a
repeated relay or enqueue adds nothing.

Subscriptions come from live activations' manifests. The daemon mirrors them
into both event databases at start and after every `plugin.*` operation. A
failed mirror write is retried on the next dispatcher pass. While the plugin
registry is unavailable, the last mirror stays.

Reliability rules:

- The claim (`dispatching`, attempts + 1) commits before the send.
- A claim still open when the daemon starts becomes `unknown`. Nothing sends an
  `unknown` or `failed` delivery on its own.
- `hook.delivery.retry` requeues a `failed` delivery. It requeues an `unknown`
  one only with `acknowledge_unknown`. The resend keeps the same effect ID.
- The retry's receipt, the state change and any refusal commit in one
  transaction. A repeat with the same operation ID returns the first answer.
- Only a delivery the host proves it never started (`not_started`) is sent
  again automatically, with backoff from 1 s to 5 min.
- The manifest must declare a backend entry point to subscribe. An unknown or
  duplicated event name is rejected before activation.
- Delivered and abandoned deliveries are pruned after 30 days. Failed and
  unknown ones stay until someone retries or abandons them.

Pure logic: `crates/ade-daemon/src/hooks/decide.rs` holds the delivery state
machine (`on_host`, `claimable`, `settle`, `recover`, `retry`, `abandon`,
`backoff_ms`).

## Operation tiers

| Operation | Tier |
|---|---|
| `hook.subscription.list` | query |
| `hook.delivery.list` | query |
| `hook.delivery.inspect` | query |
| `hook.delivery.retry` | effect command (receipt, daemon fingerprint) |
| `hook.delivery.abandon` | idempotent command |

CLI: `ade hook subscriptions | list | inspect | retry | abandon`
(`apps/cli/src/commands/hooks.ts`).

Wire change: `PluginContributions` gains an optional `hooks` array. It is
omitted when empty, so existing manifests and replies are unchanged.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-daemon/src/hooks/decide.rs` (state
  machine), `crates/ade-daemon/src/hooks.rs` (effect IDs and event mapping),
  `crates/ade-core/src/contract/hooks.rs` (event names, tiers, verdict codec),
  and new cases in `crates/ade-daemon/src/plugins/manifest.rs`.

Verified only statically: the SQL outbox (enqueue, relay, claim, settle,
recover, prune), the dispatcher thread, the subscription mirror, the
`hook.*` operations and the CLI.

Needs E2E later: install a hook-subscribing plugin, settle a turn, and see the
delivery in `awaiting_host`; restart during a send and see `unknown`; retry with
and without acknowledgement; relay of a worktree removal. Delivery itself needs
the backend plugin host (F057).

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 10 | 10 | 0 |

## References

- lux-ade `docs/proposed-architecture.md` §4 and §8, studied: outbox before dispatch, unknown outcomes, no exactly-once plugin effects.
- lux-ade `crates/ade-daemon/src/store/activity.rs`, pattern: record in the event's own transaction under a unique source key.
- lux-ade `crates/ade-daemon/src/receipts.rs`, used for the retry receipt.
- Orca @ ade-evaluation-2026-09-24, `src/main/plugins/plugin-worker-supervision.integration.test.ts`, studied: no hook outbox there; nothing copied.

## Open

- F057: a backend plugin host must implement `crate::hooks::HookHost` and replace
  `NoHost` in `Sessions`. Until then no delivery is sent.
- `worktree.cleanup` removals and Store-side workspace removal raise no hook. The
  Store never deletes a workspace record today.
- `release_service` still reads the service before its transaction, as before.
- A verdict that fails to persist leaves the delivery `dispatching` until the
  next daemon start marks it `unknown`.
- The outbox has no size cap. With no host, every event a plugin subscribes to
  accumulates in `awaiting_host`.
- A delivery for a plugin disabled after the event commits waits for the host
  and then gets `not_started` with backoff until someone abandons it.
- Backup copies `sessions.sqlite` and `sessions.worktrees/lifecycle.sqlite3`
  whole, so the new tables travel with them. Restore does not hold pending
  deliveries: a delivery queued at backup time and delivered afterwards would
  be sent again after a restore, with the same effect ID. The backup slice
  should hold `queued` and `awaiting_host` deliveries on restore, as send
  intents are held.
- Coordinator: `F058` in the requirements register stays Unverified.
