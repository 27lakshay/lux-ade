# split-sessions

Status: returned
Type: slice evidence
Branch: claude/wf_a0f63275-5ea-4
Worker: Phase 0 hot-file splits, split-sessions
Requirements: none (foundation work)

## Outcome

`crates/ade-daemon/src/sessions.rs` stays the module root and keeps `Sessions`, `Data`, `open`, `restore`, subscribe, `publish`, `changed` and the `command()` preamble. Six child modules under `crates/ade-daemon/src/sessions/` now hold the moved code: `services.rs`, `agents.rs`, `conversations.rs`, `accounts.rs`, `workspaces.rs` and `terminals.rs`. The `command()` match now sends each domain's ops to one method per domain (`service_command`, `account_command`, `workspace_command`, `terminal_command`, `conversation_command`). Each arm body moved there unchanged.

Items the move needed:

- A new `required_str` helper. It replaces the `string` closure, so `command()` and each domain method share one definition.
- `pub(super)` on moved items and fields that sibling modules or the root use. The research says no visibility changes are needed. That is true for the parent's private fields, but methods defined in a child module are private to that child.

## Operation tiers

No operation added or changed. Op strings, error text and responses are unchanged. Each domain method ends with the same `bail!("Unknown session operation")` fallback, which the thin match makes unreachable.

## Checks

- `node scripts/cargo.mjs fmt --all --check`: pass
- `node scripts/cargo.mjs clippy --locked -p ade-daemon --all-targets -- -D warnings`: pass
- `node scripts/cargo.mjs nextest run --locked -p ade-daemon --profile ci`: pass (34 passed, 5 skipped)
- `pnpm check:static`: pass. The first run failed in the `apps/cli` typecheck until `pnpm --filter @ade/client build` produced `packages/client/dist`. That is worktree setup, not a code change.
- In-process tests added: none
- A diff of the sorted, whitespace-stripped lines from the old and new files showed only the new signatures, dispatch arms, module declarations and imports.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 20 | 0 | 5 | 0 |

## References

None

## Open

- `scripts/worker-bootstrap.sh` does not build `@ade/client`, so `pnpm check:static` fails in a fresh worktree until `pnpm --filter @ade/client build` runs. The coordinator may want to add that build to the bootstrap.
