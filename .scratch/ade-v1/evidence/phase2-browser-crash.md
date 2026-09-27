# Browser crash reconciliation

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-4
Worker: Phase 2 parallel build, slice browser-crash
Requirements: F095, F101, F102 (partial; abrupt owner and daemon crash recovery for browser.open, browser.navigate and browser.close). R001/R002-style receipt rules for effect commands. No feature ID closes.

## Outcome

An Electron owner's pending browser receipt now records its intent before the effect runs: the planned tab ID for an open, and the target tab plus the prior URL for a navigate or close. After an owner crash, a lost receipt save or a daemon crash, the owner settles the receipt from its durable tabs. It does this before it registers with a daemon, on every `browser.operation` lookup, and on a same-ID retry. The result is either the proven mutation or a definite `not_applied` error. When the tabs do not prove either, the receipt stays unknown. The effect is never re-run. An open can only be settled by its own planned tab ID, so reconciliation cannot claim or create a second tab. The daemon settles an unknown receipt only from an owner answer that names that exact receipt and proves the outcome.

Decision rules (`reconcileBrowserEffect`):

| Op | Tabs now | Verdict |
|---|---|---|
| open | planned tab present | applied, that tab |
| open | planned tab absent | not applied |
| navigate | target at requested URL | applied |
| navigate | target at prior URL | not applied |
| navigate | target elsewhere or absent | unknown |
| close | target absent | applied |
| close | target present | not applied |
| any | request still in flight, or receipt predates recorded intent | unknown |

## Operation tiers

- `browser.open`, `browser.navigate`, `browser.close`: effect command (unchanged tier). The wire shape is unchanged. A settled outcome may now be a `not_applied` error.
- `browser.operation`: query (unchanged). `state: completed` may now carry a `not_applied` error result, plus an optional `evidence` field inside `result`. The contract doc on `BrowserOperationState::Completed` says so; the schema was regenerated.
- A mutation that fails before its pending receipt is written now returns a definite error, such as `unavailable` for a missing tab. It used to return `outcome_unknown`, but no effect can have run at that point.
- The client (`packages/client/src/request.ts`) and CLI now recognise the error code `not_applied`. The CLI exits with code 12 for it.

## Checks

- `pnpm check:static`: pass at the slice commit (rustfmt, contract check, architecture, SDK build, typecheck, Fallow, JS build, strict Clippy, 157 Rust tests).
- In-process tests added:
  - `crates/ade-daemon/src/bin/daemon/browser_reconcile.rs`: 4 tests, run by `check:static`.
  - `apps/desktop/src/main/browser-reconcile.test.mjs`: 5 tests, run by hand with `node --test apps/desktop/src/main/browser-reconcile.test.mjs`; all pass. `check:static` has no JavaScript test step, so the gate does not run them.

Verified only statically: the Electron wiring in `browser.ts` and `browser-owner.ts`. This covers intent recording, reconciliation on lookup, on retry and in the sweep before registration, the new receipt fields and validation, and the error-code mapping. The daemon's use of `owner_settlement` in `browser_operation` is also verified only statically.

Needs E2E later:

1. Kill Electron after the pending receipt is written and before the tab save. Relaunch; the lookup returns `not_applied`, and there is still one tab.
2. Kill Electron after the tab save and before the completed receipt is written. Relaunch; the lookup and the same-ID retry return the planned tab, with no duplicate.
3. Do the same for navigate (at the prior URL and at the new URL) and for close.
4. Kill the daemon during a dispatched mutation. The restarted daemon answers the lookup from the owner's reconciled receipt.
5. The legacy spec `e2e/specs/browser-owner-mutations-daemon.spec.ts` should still pass unchanged; it was not run.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 5 | 3 | 0 |

## References

- Orca @ b7a4fee7, `src/main/browser/browser-client-page-command-executor-fencing.test.ts`: studied (pattern). The case "close races its in-flight creation" became the rule that nothing is decided while the same request is still in flight. No code was copied.
- t3code `apps/server/src/mcp/PreviewAutomationBroker.ts`: not consulted beyond the reference map row. It has no durable request identity.

## Open

- The TypeScript decider test is not in `check:static`. The coordinator may add a `node --test apps/desktop/src/main/*.test.mjs` step to `scripts/check-static.mjs`. I did not edit the shared gate.
- Receipts written before this slice have no recorded intent, so they stay unknown when interrupted.
- An open that loaded its page before the crash, but whose tab was never saved, reports `not_applied`. The page's network request may still have reached the server.
- The pre-registration sweep scans at most 4,096 receipt files and skips unreadable ones, leaving them for review. Receipt files are still never pruned.
- A browser UI action taken between relaunch and the sweep can change the evidence. For example, a user closing a reconciled open's tab makes it read `not_applied`, but the tab state stays correct and no tab is duplicated.
- On a same-ID mutation retry, the daemon still returns `outcome_unknown` for a receipt it holds as unknown. Callers reconcile through `browser.operation`, which the legacy E2E asserts.
