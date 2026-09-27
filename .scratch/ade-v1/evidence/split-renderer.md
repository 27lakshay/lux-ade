# split-renderer

Status: returned
Type: slice evidence
Branch: claude/wf_a0f63275-5ea-2
Worker: parallel build Phase 0, hot-file splits, split-renderer worker
Requirements: none (foundation work)

## Outcome

`apps/desktop/src/renderer/src/main.tsx` shrank from 1,284 to 318 lines. The
`Window.adeHost` typing moved to `host.d.ts` unchanged; shared types to `types.ts`;
`ServicePane` to `services.tsx`; `TerminalPane` to `terminal.tsx`;
`ConversationView`, `RequestForm` and the summaries to `conversation.tsx`;
`RestoreBindingsPanel` to `restore.tsx`; and `AccountsPanel` to `accounts.tsx`.
`ConnectedContent` still owns the `accounts` list and `managedAccountId`, passing
`accounts` and `onAccounts` to `AccountsPanel`, so the new-conversation selector
and `accountLabel` read the same list. No logic, IPC channel, op string or
user-visible text changed.

## Operation tiers

None added or changed.

## Checks

- `pnpm --filter @ade/desktop typecheck`: pass (after `pnpm build` produced `@ade/client` output)
- `pnpm deadcode`: pass
- `pnpm build`: pass
- `pnpm check:static`: pass
- In-process tests added: none

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 10 | 3 | 5 | 0 |

## References

None

## Open

- `style.css` is still one stylesheet; the research suggests splitting it per pane later.
- The first desktop typecheck in a fresh worktree fails until `@ade/client` is built; `pnpm build` or `check:static` builds it.
