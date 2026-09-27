# Audit fixes: desktop

## Released quit guards never re-armed; before-quit tore down services a window could still keep

- Confirmed by tracing: `holdQuit` set `released = true` on a guard and never reset
  it, so after a later guard kept ADE open, every later quit skipped the earlier
  guard. `before-quit` then ran `closeAllTerminals()` and `stopClient()`, and
  `browserQuitGuard` closed the `BrowserOwner`, before Electron closed windows. A
  window `close` handler that failed to save a draft cancelled the quit and left
  ADE open with no terminals, a stopped `AdeClient` and no browser owner.
- Fix: the new pure `QuitCoordinator` (`apps/desktop/src/main/quit-coordinator.ts`)
  re-arms every guard when a flush returns false or throws, and when every guard
  lets an attempt through (a window may still cancel it). Destructive teardown
  (closing the browser owner, then terminals and the client) moved to
  `will-quit`, which Electron emits only after every window has closed; it holds
  the quit once, runs each step in order and quits again. `browserQuitGuard` now
  only flushes browser sessions. `quit-guards.ts` wires the coordinator to `app`.
- Test: `apps/desktop/src/main/quit-coordinator.test.mjs` reproduces the scenario
  (draft guard releases, browser guard fails, next quit re-runs the draft guard),
  a window cancelling the quit leaving teardown unrun, rejected flushes, and
  teardown ordering and single run. Runs in `pnpm check:static` (js pure tests).
- Gate: `pnpm check:static` passed.
