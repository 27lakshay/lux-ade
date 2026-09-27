# split-desktop-main

Status: returned
Type: slice evidence
Branch: claude/wf_a0f63275-5ea-1
Worker: parallel build Phase 0 hot-file splits, worker split-desktop-main
Requirements: none (foundation work; step 1 of the hot-file seams research)

## Outcome

`apps/desktop/src/main/index.ts` went from 1,669 to 243 lines. Each IPC group now sits in its own
domain module: `conversations/send-pipeline.ts`, `conversations/ipc.ts`, `review.ts`, `files.ts`,
`workspaces.ts`, `services.ts` and `terminals.ts` (which exports `closeAll()`). The browser adopt and
backup handlers moved into `browser.ts`. Connection state moved to `profile-connection.ts` behind read
accessors and setters. `index.ts` keeps window creation and the app lifecycle, including
`before-quit`. The move keeps behaviour. No IPC channel, daemon op or user-visible string changed.
A string-literal comparison and a line-by-line comparison against the old file confirmed this.

Three additions go beyond the planned module list. Each one keeps the import graph free of cycles,
which Fallow rejects:

- `profiles.ts` holds `attachClient`, `selectProfile` and the profile IPC channels. They import
  browser, terminal and workspace code. `profile-connection.ts` therefore stays a leaf module.
- `registerBrowserIpc(selectProfile)` receives `selectProfile` as a parameter, because `profiles.ts`
  imports `browser.ts`.
- `validation.ts` holds `validId`, which seven modules share.

`selectedWorkspaces` and `selectionRequests` live in `workspaces.ts`. `singleWindowId` stays in
`index.ts`, the only module that reads it. `adoptUnownedBrowserStorage`, `captureBrowserProfile` and
`restoreBrowserProfile` are no longer exported, because only `browser.ts` uses them now.

## Operation tiers

None added or changed. The IPC handlers keep their existing ops and checks.

## Checks

- `pnpm --filter @ade/desktop typecheck`: pass
- `pnpm deadcode`: pass (the first split had 4 circular dependencies; the layering above removed them)
- `pnpm build`: pass
- `pnpm check:static`: pass
- In-process tests added: none

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 5 | 5 | 0 |

## References

None

## Open

- Account ops still share `ade:conversation-request`. A separate channel was out of scope.
- The quit-guard registry is a later step. `before-quit` still reaches into drafts, browser flush,
  terminals and the client directly.
- E2E was not run, as instructed. The move preserves logic line for line, but no running app
  exercised it.
