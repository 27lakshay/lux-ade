# account-switching

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-4
Worker: Phase 2 round E, account-switching slice
Requirements: F026 (explicit in-conversation account switching, backend and CLI); D04 (switching follows the adapter's declared capability; unavailable is explicit)

## Outcome

A conversation can now move to another verified account of the same provider for future turns. The daemon does this through one effect command, one preview query and one list query, and the CLI exposes all three. No requirement is fully accepted. F026 still needs E2E and UI evidence, and no bundled adapter declares native continuation, so that path is verified only by the pure decider's tests.

Design points:

- **Eligibility is a pure function.** `crates/ade-daemon/src/account_switch.rs` holds `decide`, which reads plain facts and returns either a continuity or a refusal. It refuses in these cases:
  - The daemon is draining, or the conversation is an imported native session.
  - The target account belongs to another provider, is the current account, is not verified, or has no pinned identity.
  - A managed Claude target is combined with native settings sources.
  - A turn is active: the status is `starting`, `running`, `waiting` or `cancelling`, or there is an active turn ID.
  - A question or approval is open, the conversation is handed to a terminal, or its execution lease is unresolved after a restart.
  - The prompt queue is not empty and not paused, so queued prompts cannot run unreviewed under the new account.
- **Continuity follows the adapter's declaration.** `native_continuation` is offered only when the provider's capability record declares `conversation.account_switch` as `supported` and a native session exists. Claude, Codex, Oh My Pi and OpenCode all declare `unknown` today, because each native session lives in one account home. Every switch therefore offers `new_native_session`.
- **The caller accepts the continuity explicitly.** `account.switch` carries the `continuity` the preview offered. The daemon refuses any other value and never downgrades on its own. A request for native continuation on a provider without it is refused, and the refusal names the `new_native_session` alternative.
- **Fencing.** The request carries `expected_account_id` (the current account, or null for legacy ambient) and the target's `expected_generation`. The commit transaction checks all of the following again:
  - The stored conversation row is unchanged.
  - The target account is still `verified`.
  - The target account's generation is unchanged.
- **Effect command.** `account.switch` uses `receipts.rs` in `state.sqlite`.
  - A read-only admission probe runs first. It rolls back its own `accepted` row, and it returns the stored reply for a settled retry.
  - A reused ID with a different payload is a conflict, and an ID past retention is `expired`.
  - Four writes commit in one transaction: the receipt, the conversation's new account, the `account_switches` row and an `account_switched` activity entry.
- **Idle Agent.** An Agent that is still connected runs under the earlier account. The switch stops it with `stop_confirmed` before committing and records `agent_stopped`.
  - If the stop fails, nothing is written.
  - If the commit fails after a successful stop, the conversation is recorded as `disconnected` under the unchanged account.
- **New native session.** The switch clears `provider_thread_id` and keeps the old ID as `previous_native_session` for provenance.
  - It stores a bounded excerpt of the ADE transcript: user and assistant text, most recent first, at most 24 KiB overall and 4 KiB per message.
  - The next `agent.send` prefixes the excerpt, framed as a record, to the prompt sent to the provider. The stored user message is not changed.
  - The excerpt is marked `delivered` only after the provider acknowledges that turn.
  - A send with an unknown outcome leaves the excerpt `pending`. The excerpt can then reach the new session twice. That repeats context, never a user prompt, and it is disclosed.
  - A later switch marks an undelivered excerpt `superseded`.
- **Disclosure.** Both the preview and the switch record return a plain-language `disclosure`. It states what carries over and what does not: native tool state, hidden context and native history stay with the earlier account. It also says how many messages are transferred and whether older ones were left out.
- **Activity.** A new `ActivityKind::AccountSwitched` variant is recorded under the source key `account_switch:<operation id>`. The desktop notification policy skips unknown kinds, and turn hooks ignore it.

## Operation tiers

- `account.switch.preview`: query
- `account.switch`: effect command (operation ID, daemon fingerprint, receipt)
- `account.switch.list`: query

## Checks

- `pnpm check:static`: pass on the final commit. It covers rustfmt, the contract check, the architecture check, the SDK build, typecheck, Fallow, the JS build, JS pure tests, strict Clippy and the legacy Rust tests.
- In-process tests added:
  - `crates/ade-daemon/src/account_switch.rs`: 9 tests covering eligibility, the fences, the continuity rule, excerpt bounds, disclosure and prompt framing.
  - `crates/ade-core/src/contract/accounts.rs`: `switch_contracts_keep_their_wire_shape`.

Verified only statically:

- The receipt and transaction path in `store/account_switches.rs`.
- The stop of an idle Agent.
- The prefixing of the excerpt in `sessions/agents.rs` and the delivery mark.
- The CLI command.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

- Ghostex @ 2026-09-24 snapshot, `ghostex/server/src/accounts/switch_progress.rs` and `accounts/continuation.rs`: pattern. A manual switch starts no turn, and an uncertain delivery is never replayed. No code was copied.
- ADE `crates/ade-runtime/src/{claude,codex,omp,opencode}.rs` capability records: used as the adapter declaration.

## Open

- E2E coverage, once E2E work resumes:
  - Switch between two managed accounts of one provider.
  - Refuse the switch during a turn and with a stale generation.
  - Replay the same operation ID, and reject a conflicting reuse.
  - Show that the first turn after a switch opens a new native session under the new account home, with the excerpt.
  - Show that a disabled target is refused.
- UI: the renderer needs a switch control that shows the preview's disclosure, and a provenance view built on `account.switch.list`. Electron main's `conversations/ipc.ts` allowlist does not yet include the three operations; add them together with that UI.
- Native continuation has no real adapter. When an adapter declares `account_switch: supported`, the runtime must prove that the session opens under the new account home and passes identity readback.
- Coordinator: `ActivityKind::AccountSwitched` was added in `contract/activity.rs`, with a one-line match arm in `hooks.rs`. Merge it with any other round E slice that adds activity kinds.
