# Phase 2: runtime contracts

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-3
Worker: Phase 2 round B workflow, slice runtime-contracts
Requirements: F005 (foundation, partial), R003 (partial: gaps named below), R005 (partial)

## Outcome

The daemon-to-runtime protocol (`ade-runtime-v8`) now has typed requests and
replies in `crates/ade-core/src/runtime_protocol.rs`. Both sides use them:

- The daemon-side client is `crates/ade-runtime/src/runtime.rs`. The task named
  `crates/ade-daemon/src/runtime.rs`, but that file does not exist.
- The runtime supervisor server is `crates/ade-runtime/src/bin/supervisor/server.rs`.
- `Supervisor::command` takes `impl Into<Control>`, and `Supervisor::agent` takes
  an `AgentOp`. As a result, no daemon call site can still send an untyped frame.

The wire bytes are unchanged, for two reasons:

- `serde_json` is built without `preserve_order`, so `Value` sorts its keys.
  Serializing the typed value writes the same bytes as the old `json!` literals.
- The tests compare each typed frame with the literal each call site sent.

The version handshake is unchanged. `Hello::accept` checks `runtime_protocol`
before it decodes anything else, so a runtime of another version is still
reported as "Incompatible runtime; existing terminals were preserved".

The 28 typed operations:

| Socket | Operations |
|---|---|
| First frame (`Connect`) | `hello`, `runtime.stop`, `owner.claim`, `terminal.connect` |
| Owner control socket (`Control`) | `terminal.list`, `terminal.tail`, `terminal.stop`, `terminal.retire`, `terminal.ensure`, `terminal.restart`, `terminal.launch`; `proxy.ensure`, `proxy.inspect`, `proxy.retire`, `proxy.recovery.inspect`, `proxy.recovery.retry`, `proxy.recovery.reset`; `owner.check`, `owner.prepare`, `owner.abort` |
| Agent connection (`AgentRequest` = token + `AgentOp`) | `agent.account_inspect`, `agent.list`, `agent.create`, `agent.command`, `agent.connected`, `agent.events`, `agent.ack`, `agent.stop` |

These replies are typed: `Hello`, `Handoff`, `Ack`, `Error`, `AgentError` (its
`code` is always present, as before) and `AgentEvents<E>`. The terminal and
proxy replies reuse the existing `contract::terminals::runtime` and
`contract::services` types.

These fields stay `serde_json::Value`, because their shape is irregular or owned
by another crate:

- `agent.create.spec`: the runtime compares it verbatim with a live run's spec.
- `agent.command.command`: its shape depends on the method.
- `agent.account_inspect.account`.
- Terminal `metrics`.
- The `terminal.tail`, `terminal.list`, `agent.connected` and `agent.command` replies.

The types stay out of `@ade/contracts`. `contract::terminals::runtime` already
held the terminal runtime commands. The new module re-exports it as
`runtime_protocol::terminal` and dispatches on the `op` family.

The runtime keeps accepting frames from older senders:

- `terminal.ensure`, `terminal.restart` and `terminal.launch` still accept a
  missing `terminal_key` (which means the workspace ID), `existing_only` or
  `session_subscribers`.
- `runtime.stop` still accepts a missing `stop_active`.
- `proxy.ensure` still accepts a missing `remap` or expected route.

Behaviour changes, all fail-closed:

- A malformed frame now fails with "Invalid runtime request: …". It no longer
  gets a per-field message.
- A `terminal.stop` without IDs used to be acknowledged
  without doing anything. It is now refused.
- A port over 65535 is refused while decoding.
- A non-UTF-8 data directory or daemon socket now returns an error instead of
  panicking inside `json!`.
- `prepare_handoff` now checks that the ticket parses as a `Handoff` before it
  persists it. Any other reply aborts the handoff.
- An `agent.*` request is now decoded before the owner token is checked. A
  malformed request therefore gets a plain error instead of `owner_fenced`.
  Only the daemon sends these requests.

### Incarnation and attempt generation (architecture section 4)

What the protocol carries today:

- The runtime incarnation is `instance_id`. `hello`, `owner.claim`,
  `runtime.stop` and the handoff record check it.
- Every later control, agent and terminal-connect frame is fenced by the owner
  `token`. A token exists only on the incarnation that admitted its claim, and
  only until that owner's socket closes. So a command cannot reach a successor
  runtime or a successor daemon.
- An Agent attempt is identified by its `run` ID, which is fresh for each run.
- The daemon's service reservation compares `runtime_instance` with
  `Supervisor::instance`.

Gaps, left unchanged to keep the wire bytes:

- `terminal.stop`, `terminal.retire` and `terminal.tail` name a terminal
  (`workspace_id`, `terminal_id`), not the shell run inside it. A delayed stop
  could stop a restarted shell under the same key. The fix is an optional
  `expected_run_id` or `expected_transfer_id`, checked by the runtime.
  `scripts.rs` and `sessions/services.rs` compare `transfer_id` after the reply
  for tail and launch, but not before a stop.
- No command carries a numeric attempt generation. `agent.command` carries the
  run ID and a receipt key, but not a turn generation.
- Terminal stream frames after `terminal.connect` are relayed without parsing.
  They are not typed here and carry no stream incarnation.

## Operation tiers

No public operation was added or changed. The runtime socket is internal, and
its operations are not registered in the public bundle. For reference:

- Queries: `hello`, `terminal.list`, `terminal.tail`, `proxy.inspect`,
  `proxy.recovery.inspect`, `agent.list`, `agent.account_inspect`,
  `agent.events`, `agent.connected`, `owner.check`.
- Idempotent commands: `terminal.ensure`, `agent.ack`, `owner.abort`.
- Effect commands: everything else. The daemon's receipts cover them.

## Checks

- `pnpm check:static`: pass.
- In-process tests added (9): `crates/ade-core/src/runtime_protocol.rs`, in
  `#[cfg(test)]`. They cover:
  - frame equality and round trips for all 28 requests and the typed replies;
  - frames from older senders that omit optional fields;
  - refusal of unknown or misrouted operations;
  - the `Hello::accept` decider;
  - the `Handoff::ticket_for` decider.
- Legacy tests changed only to compile:
  - The `runtime.rs` owner-fence test now sends `AgentOp::Command`.
  - The `terminals.rs` wire test now passes `terminal_key: Some(..)`.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

None. `08-reference-map.md` has no row for the runtime control protocol. Its
Orca incarnation row (`orca/src/shared/pty-incarnation.ts`) applies to the
terminal-stop gap above, but I did not study or copy it for this slice.

## Open

- Add a shell-run fence to `terminal.stop`, `terminal.retire` and `terminal.tail`
  (see the gaps above). The daemon must send it, so this is a v9 or an additive
  optional field.
- Type the terminal stream frames (`input`, `resize`, `snapshot`, …, in
  `terminal_host.rs`) when stream incarnation is added.
- `ade-control` (`crates/ade-daemon/src/bin/control/main.rs`) still sends an
  untyped `{"op":"hello"}` probe to the runtime socket over its own RPC helper.
  The bytes are the same.
- The public `AgentListRequest` and `AgentAccountInspectRequest` in
  `contract/agents.rs` stay in the bundle for compatibility. The runtime now
  decodes `AgentRequest` instead.
- No shared-file changes are needed. The only one-line shared edit is
  `pub mod runtime_protocol;` in `crates/ade-core/src/lib.rs`.
