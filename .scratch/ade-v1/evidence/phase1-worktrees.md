# phase1-worktrees

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-8
Worker: Phase 1 typed domains, worktrees worker
Requirements: none (Phase 1 contract typing; D02 contracts, section 4 receipts)

## Outcome

The ten `worktree.*` operations now have typed request and reply contracts in
`crates/ade-core/src/contract/worktrees.rs`. The lifecycle daemon decodes every
request into them and builds every reply from them. The lifecycle database's
receipt role moved onto `crates/ade-daemon/src/receipts.rs`: schema 4 renames the
old ledger table `operations` to `jobs` and creates the shared receipt table under
the `operations` name. The CLI and Electron main process call these operations
through `dailyUseCommand`, which validates requests and decodes replies.

## Operation tiers

| Operation | Tier | Reply |
|---|---|---|
| `worktree.repository` | idempotent command | `worktree_state` |
| `worktree.get` | query | `worktree_state` |
| `worktree.switch` | effect command (receipt) | `worktree_state` |
| `worktree.adopt` | effect command (no operation ID yet) | `worktree_state` |
| `worktree.remove` | effect command (receipt) | `worktree_state` |
| `worktree.refresh` | effect command (receipt) | `worktree_state` |
| `worktree.configure` | idempotent command | `worktree_state` |
| `worktree.operation` | query | `worktree_operation` |
| `worktree.rebind` | idempotent command | `worktree_state` |
| `worktree.rebind.list` | query | `worktree_rebind_catalog` |

`sessions.worktrees` is not an operation. It is the lifecycle data directory
(`sessions.worktrees/lifecycle.sqlite3`), so it has no contract.

`worktree.refresh` only reads Git, but it runs a supervised Git process under the
repository lock and has always carried a request ID, so it stays an effect
command. `worktree.adopt` writes an ownership marker into Git's admin directory
and fails on a second run; it has no operation ID today.

## Receipts

- `worktree.switch`, `worktree.remove` and `worktree.refresh` accept
  `operation_id`; `request_id` still works as a serde alias. The fingerprint is
  taken over the typed request, so both spellings fingerprint the same.
- Admission probes the receipt in a rolled-back transaction first. A replay
  returns the repository snapshot, as before. A conflict keeps the message
  "Request ID was already used for different parameters". An expired ID is
  rejected with a new message.
- The receipt (`begin`, then `dispatched`) and the `jobs` row commit in one
  transaction. Completion writes the repository, the `jobs` row and the settled
  receipt in one transaction; before, these were two separate writes.
- Ledger status maps to receipt status: running is `dispatched`, interrupted is
  `unknown`, succeeded, partial and failed are `settled`.
- Existing rows: migration 4 keeps every ledger row and its rowid in `jobs`.
  At every open the daemon backfills a receipt for each `jobs` row that has none,
  fingerprinted from the stored request and dated from `started_at`, then moves
  each receipt to the status of its row. Old IDs with the same parameters still
  replay, and different parameters still conflict. A row that no longer decodes
  gets a receipt over its raw request, so reuse of that ID conflicts. Rows older
  than 30 days now answer a reused ID with `expired`, where before they
  replayed forever. `receipts::prune` runs at open.
- A scratch test (not committed) opened a hand-built schema-3 database and
  confirmed: version 4, receipts `settled` and `unknown`, replay with
  `operation_id` of a row stored with `request_id`, conflict on changed
  parameters, and `New` for an unknown ID.

## Wire shapes

Confirmed against the handler code in `crates/ade-daemon/src/worktrees.rs` and
the callers in `apps/cli/src/commands/workspaces.ts` and
`apps/desktop/src/main/workspaces.ts`.

Deliberate or unavoidable differences:

- `worktree_state.operations[]` rows written before `binding_generation` or
  `worktree_path` existed now carry `binding_generation: 0` and
  `worktree_path: null`. The daemon previously echoed the raw row.
- Type mismatches the daemon used to ignore are now rejected, with serde's
  message: a non-boolean `create` or `force`, a non-string `base`, `path` or
  `delete_branch`. The typed CLI and desktop callers never send those.
- A missing field keeps "Missing or invalid <field>"; a missing operation ID
  still says `request_id`. `worktree.configure` keeps serde's own message for
  a bad `config`.
- `request` and `result` in `WorktreeOperation` are `serde_json::Value`: `request`
  is the caller's raw request, and `result` is the Git output record.
- The request schema lists `operation_id` only, because schemars ignores serde
  aliases. The daemon still accepts `request_id`. The CLI now sends `operation_id`,
  and its printed result still carries `request_id`.
- A non-string `delete_branch` value was treated as `keep`; it is now rejected.
  The schema lists `keep` and `merged`; the daemon still reads the raw string
  so an unknown policy keeps "Branch policy must be keep or merged".

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build,
  typecheck, Fallow, JS build, clippy, legacy Rust tests: 104 passed).
- In-process tests added: `crates/ade-core/src/contract/worktrees.rs`
  (`#[cfg(test)]`: request alias decoding, request round trips, schema
  rejections, reply round trips, legacy ledger defaults).
- Legacy tests touched: `crates/ade-core/src/contract/tests.rs` (tier list
  extended with the worktree operations) and the legacy lifecycle test in
  `crates/ade-daemon/src/worktrees.rs` (table name `jobs`, enum status). Neither
  gained new cases.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

None.

## Open

- Files outside this domain changed because the lifecycle schema moved to 4:
  `crates/ade-daemon/src/bin/control/backup.rs` (expected version 4, restore
  rewrites `jobs`) and `scripts/managed_backup.py` (accepts 1 to 4, picks the
  ledger table by version). Backup bundles taken at lifecycle schema 3 fail
  `backup.rs`'s exact version check, the same rule `sessions.sqlite` follows.
- `crates/ade-core/src/contract/tests.rs` pins the full operation list; every
  worker extends it, so the coordinator resolves that conflict at merge.
- The CLI and desktop worktree calls sit in `workspaces.ts` files that the
  workspaces worker may also edit.
- `worktree.adopt` is an effect command without an operation ID or receipt.
- Legacy `scripts/test_worktrees.py` already sends configuration keys the daemon
  rejects (`path_template`, `hooks`); it is not part of `check:static`.
