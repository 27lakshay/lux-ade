# bridge-namespaces

Status: returned
Type: slice evidence
Branch: claude/wf_3f97c965-a4e-1 (slice bridge-namespaces)
Worker: Phase 0 foundation workflow, worker bridge-namespaces
Requirements: none (foundation work; step 5 of `.scratch/parallel-build/research/05-hot-file-seams.md`)

## Outcome

`window.adeHost` now groups its methods into `profiles`, `conversations`, `workspaces`,
`services`, `review`, `files`, `browser` and `terminal`. Each domain declares its interface in
`apps/desktop/src/renderer/src/host/<domain>.ts` and implements it in
`apps/desktop/src/preload/<domain>.ts`; `host.d.ts` and `preload/index.ts` only compose them.
Every renderer call site uses the namespaces. IPC channel names are unchanged (the 47 channel
strings in the built preload bundle match the old preload exactly).

`apps/desktop/src/main/quit-guards.ts` adds a quit-guard registry. The draft guard
(`conversations/quit-guard.ts`, with `warnPendingSends` moved beside it) and the browser guard
(`browser.ts`) register in that order from `main/index.ts`; `before-quit` calls `holdQuit` and
then closes terminals and stops the client as before. Each guard keeps its old released and
in-progress flags, re-check on every quit attempt, and failure handling.

## Operation tiers

No daemon operation was added or changed. The renderer-facing bridge changed shape only.

## Checks

- `pnpm check:static`: pass
- `pnpm --filter @ade/desktop typecheck`, `pnpm deadcode`, `pnpm build`: pass
- In-process tests added: none

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 5 | 10 | 0 |

## References

- Electron docs, `contextBridge` (https://www.electronjs.org/docs/latest/api/context-bridge): nested objects of functions are allowed in `exposeInMainWorld`.
- Electron docs, `app` `before-quit` and `app.quit()` (https://www.electronjs.org/docs/latest/api/app): pattern kept from the existing handler.
- No reference repo used.

## Open

- `preload/index.ts` still exposes flat aliases (`getProfileState`, `selectProfile`,
  `requestConversation` and eight more) because existing E2E specs call them through
  `window.evaluate`. The renderer type does not include them. Migrate the specs to the
  namespaces, then delete `e2eAliases`.
- `getAppVersion` stays top-level: it belongs to no domain module (`ade:app-version` is
  handled in `main/index.ts`), and `desktop-smoke.spec.ts` calls it.
- The window `close` handler in `main/index.ts` still carries its own draft flush; it is a
  per-window guard, not a quit guard, and was left as is.
