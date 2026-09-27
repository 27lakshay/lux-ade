# Audit fix: runtime

Status: returned
Type: slice evidence
Branch: claude/wf_bb3781ba-3ed-4
Worker: audit-fix workflow, runtime area
Requirements: none (reliability fixes from the post-merge audit)

## Outcome

Two confirmed defects are fixed. A late control reply can no longer be read as the reply to a later command. A stop whose process tree is still live or unverifiable no longer reports an exit, so it releases no service, script or lease ownership. No wire contract changed: the runtime protocol version is the same, and `exit_status` already had an `unknown` kind.

## Defects

### 1. A late control reply was read as the reply to the next command

- Fix, `crates/ade-runtime/src/runtime.rs`: the owner socket is now an `OwnerChannel`. It counts the replies it still owes and keeps any partial frame across read timeouts. Before it sends a command, it reads and discards each owed reply. If an owed reply has still not arrived, it refuses the new command without sending it. After a partial write, EOF or a malformed frame, it marks the channel broken and sends nothing more. `channel_fault` decides whether an I/O error means late or broken.
- Fix, `crates/ade-runtime/src/bin/supervisor/server.rs`: `agent.create` no longer holds `host.data` while `Run::spawn` probes the CLI. It reserves the run in `State.starting` under the lock, launches without the lock, then inserts or rolls back the run under the lock. A guard frees the reservation if the launch unwinds. `admit_create` decides admission. Starting runs count toward the 16-Agent limit and the one-Agent-per-Conversation rule. A duplicate create for a starting run waits and then acks. `runtime.stop` without `stop_active` also refuses while a launch is in flight.
- Tests:
  - `runtime::tests::late_control_reply_is_discarded_not_read_as_the_next_reply` reproduces the scenario: a `terminal.list` times out, and a `terminal.stop` gets the stop's own refusal, not the stale `terminals` list.
  - `runtime::tests::a_frame_split_across_a_timeout_is_kept_whole`
  - `server::tests::a_starting_agent_blocks_duplicates_but_not_unrelated_creates`
  - `server::tests::starting_agents_count_toward_the_limit`

### 2. A stop whose process tree was live or unverifiable was reported as an exit

- Fix, `crates/ade-runtime/src/bin/supervisor/terminal_host.rs`: a tracked terminal (a launch with a transfer ID) now records its reaped child as `{"kind":"unknown","verifying":true,"child":…}`. The status stays that way until the tree verdict is known, so the old window where a plain exit showed without a verdict is gone. `settle_exit` then reports the child's own status only when the verdict is `exited`. When the verdict is `live` or `unverifiable`, it reports `kind: "unknown"` and keeps the child status under `child` and the verdict under `descendants`.
- Fix, daemon consumers:
  - `sessions/leases.rs::terminal_liveness` is extracted from `observe_terminals`. Only `success`, `failure` or `signaled` counts as exited. `release_exited_script_leases` in `sessions.rs` now uses it.
  - In `sessions/services.rs`, `stop_service` uses `stop_progress`. It waits while the runtime is still verifying. If the process was reaped but its tree is unconfirmed, it refuses and keeps the service reservation and the terminal lease.
  - In `scripts.rs`, `script.stop` waits through the verifying state (`stop_settled`), then reports the run as `unknown`, not as exited.
- Tests:
  - `terminal_host::tests::only_an_exited_tree_reports_the_child_status`
  - `sessions::services::stop_tests::a_live_or_unverified_tree_never_counts_as_stopped`
  - `scripts::stop_tests::a_stop_with_a_live_tree_answers_unknown_not_exited`

## Operation tiers

No operations were added or changed.

## Checks

- `pnpm check:static`: pass. It ran 692 Rust tests.
- In-process tests added: see each defect above.

## References

None.

## Open

- A service whose tree stays unconfirmed now keeps its reservation. `service.stop` refuses each retry until recovery settles it, for example through `runtime.recovery.release`. No new release path was added.
- `terminal.retire` in `bin/daemon/server.rs` and `sessions/terminals.rs` still checks only `shell_running`. The audit did not list it.
- A control command that times out still returns an error. Its outcome is unknown to the caller, as before. The difference is that the next command no longer reads its reply.
