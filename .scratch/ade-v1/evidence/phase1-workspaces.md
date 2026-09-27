# phase1-workspaces

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-4
Worker: workflow wf_e0896549, worker 4 (workspaces domain)
Requirements: none (Phase 1 typed contracts; D02)

## Outcome

The five workspace binding operations now have typed request and response
contracts in `crates/ade-core/src/contract/workspaces.rs`. The daemon handlers
decode requests into those types and build replies from them; the CLI and Electron
main callers use `dailyUseCommand`, which validates both directions against the
generated schema. The wire shapes are unchanged.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `catalog.get` (already typed) | query | `CatalogGetRequest` | `CatalogFrame` |
| `workspace.open` | idempotent command | `WorkspaceOpenRequest` | `WorkspaceAck` |
| `workspace.rebind.list` | query | `WorkspaceRebindListRequest` | `WorkspaceRebindCatalog` |
| `workspace.rebind` | idempotent command | `WorkspaceRebindRequest` | `WorkspaceAck` |
| `repository.rebind.list` | query | `RepositoryRebindListRequest` | `RepositoryRebindCatalog` |
| `repository.rebind` | idempotent command | `RepositoryRebindRequest` | `RepositoryAck` |

`workspace.open` returns the existing record for a known root. The two rebind
commands change only ADE's saved binding. A repeat is rejected (the target is
already bound), so the state converges. None of them had a receipt table, so
nothing moved to `receipts.rs`.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-core/src/contract/workspaces.rs` (`#[cfg(test)]`
  schema round trips, tier declarations, closed requests, reply tags)

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 25 | 5 | 5 | 0 |

## References

None.

## Open

- `crates/ade-core/src/contract/tests.rs` asserts the exact list of registered
  operations. I added the five workspace operations to that list. Every domain
  worker has to edit the same list, so expect a conflict there at merge.
- `WorkspaceRebindEntry` moved from `store/bindings.rs` into the contract. The store
  re-exports it with `pub use`, so the `pub use bindings::*` glob in `store.rs`
  still exports something.
- `RepositoryRecord` mirrors `model::Repository`, which does not derive
  `JsonSchema`. I left `model.rs` alone because it is shared. The coordinator could
  derive `JsonSchema` on `Repository` and drop the mirror.
- Error wording changed only for malformed requests. A non-string `path`, `workspace_id`
  or `repository_id` now fails with `Invalid request: invalid type ...` instead
  of `Missing <field>`. When several fields are missing, the rebind handlers now
  report the missing field before a bad path. An empty string still returns
  `Missing <field>`. A pending lifecycle rebind is still checked before the request
  is decoded.
- In Electron main, a bad `repository.rebind.list` or `workspace.rebind.list` reply
  now fails with the `dailyUseCommand` contract error before the older
  `invalid recovery catalog` check runs.
