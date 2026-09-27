# Phase 1 accounts

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-3
Worker: wf_e0896549 Phase 1 typed domains, accounts worker
Requirements: none (contract typing of existing operations)

## Outcome

`provider.list` and the five `account.*` operations now have typed requests and
replies in `crates/ade-core/src/contract/accounts.rs`. The daemon handler in
`crates/ade-daemon/src/sessions/accounts.rs` decodes and replies through them.
The CLI (`apps/cli/src/commands/accounts.ts`) and the desktop account branch in
`apps/desktop/src/main/conversations/ipc.ts` call them through `dailyUseCommand`.
That path validates requests and replies against the generated contract.

## Operation tiers

| Operation | Tier | Why |
|---|---|---|
| `provider.list` | query | Reads the static descriptor list |
| `account.list` | query | Reads the accounts table |
| `account.inspect` | query | Runs the provider's read-only status probe and changes no state |
| `account.create` | effect command | Every call mints a new account ID and native home directory |
| `account.verify` | idempotent command | Guarded by the expected generation and pinned identity, so a repeat converges |
| `account.disable` | idempotent command | Leaves the account disabled with no identity; each call also bumps `generation` |

No account operation had a receipt or idempotency table, so nothing moved onto
`receipts.rs`. `account.create` is an effect command that has no `operation_id`
and no receipt yet.

## Wire shapes

Replies are unchanged: `providers`, `accounts`, `ack` (with `account`, plus
`native_logout: false` for disable) and `account_inspection`. `inspection.version`
and `inspection.identity` stay present as `null` when absent. `expected_identity`
and `inspection.identity` are typed as `Value` because their shape depends on
the provider.

Error-message differences from before, all for malformed input that no ADE
client sends:

- A non-string `provider`, `name` or `account_id` now fails with
  `Invalid request: …` instead of `Missing <field>`.
- A missing `account_id` still returns `Missing account_id`, but now before any
  lookup.
- A non-integer or negative `expected_generation` now fails with
  `Invalid request: …` instead of `Missing expected account generation`.
- An explicit `expected_identity: null` now fails with
  `Missing inspected <provider> identity`. Before, it failed after inspection
  with `Account identity changed since inspection; inspect again`.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-core/src/contract/accounts.rs` (reply
  round-trips, verify-request absent fields, inspection with optional fields
  missing)

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 5 | 10 | 0 |

## References

None.

## Open

- `crates/ade-core/src/contract/tests.rs`
  (`every_operation_declares_a_tier_and_named_types`) pins the exact operation
  list. I added the six account rows. Every worker will edit that list, so the
  coordinator should expect a conflict there.
- `crates/ade-core/src/model.rs`: `Account`, `ClaudeIdentity`, `CodexIdentity`
  and `OmpIdentity` now derive `JsonSchema`.
- The `conversation.create` branch of `ipc.ts` still calls `provider.list`
  through untyped `requestDaemon`. I left it for the conversations owner.
- `ade_runtime::provider::catalogue()` no longer has a daemon caller.
- The renderer (`apps/desktop/src/renderer/src/accounts.tsx`) still reads the
  untyped replies through the preload bridge.
