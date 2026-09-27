# split-store

Status: returned
Type: slice evidence
Branch: claude/wf_a0f63275-5ea-5
Worker: parallel build Phase 0 hot-file splits, worker split-store
Requirements: none (foundation work)

## Outcome

`crates/ade-daemon/src/store.rs` is now the module root: it keeps `Store`, the shared
helpers (`one`, `all`, `encode`, `decode`, `check_id`, `check_text`, `transaction`,
`BUSY`, `TEXT_LIMIT`) and declares child modules under `crates/ade-daemon/src/store/`:
`migrations`, `accounts`, `send_intents`, `bindings`, `terminals`, `attachments`,
`conversations`, `windows` and `tests`. The move is behaviour-preserving. The only
code edits are `pub(super)` on five free functions used across child modules
(`attachment_row`, `validate_attachments`, `write_binding`, `message_by_id`,
`write_conversation`) and re-exports that keep `crate::store::{SendIntent,
probe_catalog_bindings, forget_terminal_views, ...}` paths unchanged.

Placement of lines the research table left unassigned:

- `Store::workspace_open` and `Store::catalog` went to `bindings.rs`.
- `Store::conversation` went to `conversations.rs`.
- `migration_interruption_checkpoint` (test-only) went to `migrations.rs`.

The tests module moved unchanged apart from dedenting. It keeps its four `#[ignore]`
attributes and its `store::tests::` path. rustfmt rewrapped one `assert_eq!`.

## Operation tiers

None. No operation was added or changed.

## Checks

- `node scripts/cargo.mjs fmt --all --check`: pass
- `node scripts/cargo.mjs clippy --locked -p ade-daemon --all-targets -- -D warnings`: pass
- `node scripts/cargo.mjs nextest run --locked -p ade-daemon --profile ci`: pass (34 passed, 5 skipped)
- `pnpm check:static`: pass
- In-process tests added: none

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 15 | 3 | 7 | 0 |

## References

None

## Open

- `pnpm check:static` failed in a fresh worker tree until `pnpm --filter @ade/client build`
  produced `packages/client/dist`, because `apps/cli` resolves `@ade/client` through that
  output. `scripts/worker-bootstrap.sh` may need to build the client.
- Migration version numbers stay in the one `Store::open` ladder in `store/migrations.rs`;
  the coordinator still assigns them.
