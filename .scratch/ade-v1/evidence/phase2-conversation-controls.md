# conversation-controls

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-7
Worker: Phase 2 round D, conversation-controls worker
Requirements: F035, F039, F040, F046 (advanced, none accepted); decision D04 (native adapter capability coverage for steering, rewind and compaction recorded)

## Outcome

The daemon now answers which conversation controls a Conversation supports,
from a pure decider that records what each runtime adapter actually calls.
Codex steering (`turn/steer`) and compaction (`thread/compact/start`) run end
to end from the daemon through the runtime to the Codex 0.157.0 app-server.
File rewind restores a workspace checkpoint for every provider. Conversation
rewind, and steering and compaction on Claude, Oh My Pi and OpenCode, return
`unavailable` with the adapter's limitation. Snoozes are durable, wake after a
restart, and record one `snooze_ended` activity each. No requirement is
accepted: there is no UI and no E2E coverage, and no real provider run was made.

## Operation tiers

| Operation | Tier | Notes |
|---|---|---|
| `conversation.controls` | query | One `ControlAvailability` per control (steer, compact, rewind_conversation, rewind_files) with `mechanism` and `reason`, plus the active snooze. |
| `conversation.steer` | effect command | Receipt in the profile database. Requires `turn_id` to equal the running turn. The operation ID becomes the steered message's `clientUserMessageId`. Replies `acknowledged` with the turn Codex named. |
| `conversation.compact` | effect command | Replies `acknowledged` when Codex accepts the start. The transcript shows a `contextCompaction` item when it finishes; ADE never claims a new context state itself. |
| `conversation.rewind.preview` | query | Availability, plus the checkpoint restore preview for an available file rewind. |
| `conversation.rewind` | effect command | `files`: its own receipt, then `checkpoint.restore` under the derived operation ID `<operation_id>:files`. `conversation`: always `unavailable`, and no receipt is recorded. |
| `conversation.snooze` | idempotent command | The same wake time converges; a new one replaces it. The wake time must be in the future and at most 366 days ahead. |
| `conversation.unsnooze` | idempotent command | Ends a snooze without a wake activity. |
| `conversation.snooze.list` | query | Soonest wake first; limit 1 to 500. |

Design notes:

- Admission records the receipt and runs the availability and turn checks in
  one transaction. A refusal rolls the receipt back, so an unavailable control
  leaves no receipt.
- A dispatched receipt stores the runtime run ID. The runtime keys each native
  call as `steer:<operation_id>` or `compact:<operation_id>` and keeps the
  result in its receipt. A retry on the same run asks the runtime again and
  gets the stored answer; a retry on another run settles `unknown` and never
  calls the provider. A failed call leaves the receipt dispatched and says the
  outcome was not confirmed.
- A refused steer or compaction no longer ends the Agent run. In the runtime,
  `steer` and `compact` errors stay in the command receipt and append no
  `OperationFailed` event.
- File rewind is reconciled by the checkpoint receipt. The outer receipt only
  maps the restore result to `restored`, `unchanged` or `partial`.
- Snoozes live in `conversation_snoozes` in the profile state database, created
  with `CREATE TABLE IF NOT EXISTS`. A wake thread runs at start and then at
  most one second apart. Each wake deletes the row and records the activity in
  one transaction, under the source key `snooze:<conversation>:<snoozed_at>:<until>`.
  A snooze never touches agent status, the queue or any turn.
- The Codex adapter now maps `contextCompaction` items to a transcript entry
  instead of the "Unrecognized Codex item" fallback.
- The desktop notification policy presents `snooze_ended` as "Snooze ended".

Provider coverage (D04), as `availability.rs` records it:

| Provider | Steer | Compact | Conversation rewind | File rewind |
|---|---|---|---|---|
| Codex 0.157.0 | `turn/steer` | `thread/compact/start` | unavailable: `thread/revert` exists but rewrites only provider history and is not called | checkpoints |
| Claude Agent SDK 0.3.281 | unavailable: the adapter admits one turn at a time | unavailable: the compaction command is not issued | unavailable: resuming at an earlier message is not used | checkpoints |
| Oh My Pi 18.3.0 | unavailable: RPC `steer` exists, but the submission ledger cannot bind a steered entry | unavailable: RPC `compact` is not called | unavailable: RPC `branch` is not called | checkpoints |
| OpenCode v2 | unavailable: no steer path | unavailable: compaction is not called | unavailable: revert is not called | checkpoints |

The Codex methods and their parameters were checked against the schema that
`codex app-server generate-json-schema` prints for the installed 0.157.0 build.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/sessions/controls/availability.rs`: provider support, running-turn and connection rules, terminal ownership, unavailability everywhere for conversation rewind, file rewind only while idle
  - `crates/ade-daemon/src/sessions/controls.rs`: receipt replay (ask the same run, unknown on another run, stored reply, unknown stays unknown), restore outcome mapping
  - `crates/ade-daemon/src/store/snoozes.rs`: wake-time bounds, convergence and replacement, bounded wait, one wake key per snooze
  - `crates/ade-core/src/contract/conversations.rs`: declared tiers and round trips of the new types
  - `apps/cli/src/commands/wake-time.test.mjs`: the CLI's wake-time parser
  - `apps/desktop/src/main/notification-policy.test.mjs`: one assertion for `snooze_ended`

Verified only statically: the daemon handlers, the runtime `steer` and
`compact` commands, the Codex adapter calls, the snooze wake thread and the
`ade conversation` CLI actions. None of them ran against a live daemon or
provider in this slice.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 80 | 0 | 15 | 0 |

## References

- oh-my-pi @ ade-evaluation-2026-09-24, `docs/rpc.md`, studied: native `steer`, `compact` and `branch` commands, recorded as unwired in the decider.
- opencode-v2 @ ade-evaluation-2026-09-24, `packages/core/src/session/compaction.ts` and `revert.ts` (names only), studied: native compaction and revert exist, recorded as unwired.
- Codex 0.157.0 app-server JSON Schema (generated locally), studied: `TurnSteerParams`, `ThreadCompactStartParams`, `ThreadRevertParams`, `ContextCompactionThreadItem`.
- Claude Agent SDK 0.3.281 `sdk.d.ts` in `providers/claude/node_modules`, studied: `rewindFiles` needs `enableFileCheckpointing`, `resumeSessionAt`, user-message `priority`.
- No code was copied.

## Open

- E2E later: steer a running Codex turn and observe the steered message and
  acknowledgement; steer an idle or non-Codex Conversation and see
  `unavailable` with no queued message; compact and observe the
  `contextCompaction` item; preview and rewind files, including a stale state
  token and a partial restore; snooze, restart ADE, and see the wake activity
  when due while the agent keeps running.
- UI later: controls in the conversation view driven by `conversation.controls`,
  a snooze picker, and hiding snoozed items from attention views.
- Not built: conversation rewind for any provider. It needs the adapter call
  (Codex `thread/revert`, Oh My Pi `branch`, OpenCode revert, Claude
  `resumeSessionAt`) and invalidation of ADE's stored messages and history
  pages after the rewind point.
- Not built: steering and compaction for Claude, Oh My Pi and OpenCode. Claude
  needs a steer path and the compaction command with `compact_boundary`
  handling; Oh My Pi needs its submission ledger to bind steered entries.
- Not built: provider file rewind (Claude `rewindFiles`). ADE's checkpoints
  cover every provider, but only for checkpoints that exist.
- Races left open: the prompt queue can dispatch between a compaction or file
  rewind check and its start. Codex and the checkpoint's state token are the
  last line of defence.
- The steered message is not written to ADE's store before dispatch; it appears
  when Codex echoes the user item with its client ID.
- Shared files for the coordinator: `ActivityKind::SnoozeEnded` was added in
  `crates/ade-core/src/contract/activity.rs` (another domain's contract), and
  `snooze_ended` in `apps/desktop/src/main/notification-policy.ts`. The new
  `conversation_snoozes` table in the profile state database needs the backup
  coverage slice to confirm it is included.
