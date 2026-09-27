# Browser automation

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-7
Worker: Phase 2 parallel build, round E, slice browser-automation
Requirements: F095 (partial: public operation path for click, type, evaluate, wait and screenshot on an explicit owner and tab), 08-S12 (partial: a closed tab fails the operation), F101 and F102 (partial: the new operations are in the command API and the CLI). No feature ID closes; F095 needs E2E acceptance.

## Outcome

Agents can now drive one exact browser tab through the daemon: click and type as effect commands, and evaluate, wait and screenshot as queries. Every request names its owner and tab; the owner resolves that tab under its live lease and never the selected or focused one. Click, type and evaluate use the tab's debugger, and refuse with `conflict` when DevTools is open or a debugger client outside ADE holds the tab. ADE's own diagnostics attachment is shared, not taken over.

Click and type reuse the `browser.navigate` receipt path end to end. The daemon's dispatch half of `browser_mutation` moved into a shared `Host::browser_effect`; the owner's `mutateBrowserOwner` gained an input action. The owner records a pending receipt with `stage: prepared`, waits for the element, takes the debugger, and durably marks `stage: dispatching` just before input reaches the page. Reconciliation rules:

| Receipt after an interruption | Verdict |
|---|---|
| `prepared` (input never sent) | `not_applied`, evidence `input_not_dispatched` |
| `dispatching` | unknown, evidence `input_unobservable`; the input is never re-sent |
| failure before the dispatching mark, in process | receipt settles `not_applied`; the caller gets the definite error (`conflict`, `invalid_request` or `unavailable`) |

The receipt never stores the selector or the typed text; the fingerprint covers them.

`browser.evaluate` runs `Runtime.evaluate` with `throwOnSideEffect: true` and a V8 `timeout`, so V8 refuses any expression whose side effects it cannot rule out (reported as `invalid_request`). Values return by JSON value and are left out, marked `truncated`, above 64 KiB; exception text is cut to 1024 characters; promises are refused.

## Operation tiers

- `browser.click`: effect command. Reply: `browser_mutation` (existing type).
- `browser.type`: effect command. Reply: `browser_mutation`.
- `browser.evaluate`: query. Reply: `browser_evaluation`.
- `browser.wait`: query. Reply: `browser_wait`; a timeout is `satisfied: false`, not an error.
- `browser.screenshot`: query. Reply: `browser_screenshot` (viewport, at most 1600 px a side and 512 KiB, base64).
- Changed, wire-compatible: the daemon now also refuses a `browser_mutation` reply whose `op` differs from the request, as an unknown outcome. The owner socket allows 30 s per request after its frame arrives, instead of 5 s idle.

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build, typecheck, Fallow, JS build, JS pure tests, strict Clippy, legacy Rust tests).
- In-process tests added:
  - `crates/ade-core/src/contract/browser.rs`: `automation_requests_and_replies_round_trip`.
  - `crates/ade-daemon/src/bin/daemon/server/browser_automation.rs`: 5 tests (selector and text bounds, effect and query checks, cross-language fingerprint vectors).
  - `apps/desktop/src/main/browser-automation-core.test.mjs`: 7 tests (selector, text and expression checks, the same fingerprint vectors, the attachment decision, evaluation bounding, wait rules, click and type reconciliation).

Verified only statically: all Electron wiring in `browser-automation.ts`, `browser-owner.ts`, `browser.ts` and `browser-diagnostics.ts`; the daemon relay and `browser_effect` refactor; the CLI command.

Needs E2E later:

1. Click a fixture button and type into an input on a named tab while another tab is selected; the selected tab is untouched.
2. Open DevTools on the tab; click, type and evaluate return `conflict` and the receipt reads `not_applied`.
3. Close the tab; the next automation call fails `unavailable` without touching the newly selected tab (08-S12).
4. Kill Electron between the dispatching mark and input; `browser.operation` stays unknown. Kill it before the mark; it reads `not_applied`.
5. Evaluate `document.title` (value), `document.title = 'x'` (refused) and a large array (truncated).
6. Whether `Input.insertText` and `Input.dispatchMouseEvent` reach a tab whose window is not focused or whose view is hidden, and whether `capturePage({ stayHidden })` paints a hidden tab.
7. The Electron debugger note that `sendCommand` right after `attach` may wait for a navigation; each call is bounded at 2 s, but a real page must confirm it answers.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 8 | 0 |

## References

- Paseo @ snapshot 2026-09-24, `packages/desktop/src/features/browser-automation/actionability.ts` (Apache-2.0): copied with changes → `apps/desktop/src/main/browser-automation-core.ts` (`actionabilityScript`). Header carries the attribution.
- Paseo, `packages/desktop/src/features/browser-automation/trusted-input.ts` and `cdp-session-queue.ts` (Apache-2.0): pattern (CDP mouse press and release sequence, `Input.insertText`, one debugger turn per page). No code copied.
- Chrome DevTools Protocol `Runtime.evaluate` (`throwOnSideEffect`, `timeout`), checked against the protocol JSON on 2026-09-27.
- Electron `webContents` and `debugger` docs, checked 2026-09-27: `sendInputEvent` needs a focused window, so input goes through CDP instead; opening DevTools detaches the debugger.

## Open

- Coordinator: add a `THIRD-PARTY-NOTICES.md` entry for the Paseo (Apache-2.0) portions in `apps/desktop/src/main/browser-automation-core.ts`.
- While automation holds its own debugger attachment, `browser.diagnostics.attach` and recordings on that tab get `conflict` until it releases. If diagnostics detaches while automation shares its attachment, the automation step fails (`conflict`, or `outcome_unknown` after the dispatching mark).
- Not built: key presses, hover, drag, scroll, select options, file upload, dialogs, child-frame targeting, element screenshots (F094 covers one), accessibility snapshots, and runtime-owned background sessions for unattended automation.
- The selector and actionability checks run in an isolated world, but page scripts can still move focus or the element between the check and the input; the input then lands wherever the page put it.
- Scrolling the element into view and focusing it for `type` happen before the dispatching mark and are not counted as the effect.
- On a same-ID retry of an interrupted click or type the daemon returns `outcome_unknown`; callers reconcile through `browser.operation`, as for navigate.
- UI later: surface automation ownership and DevTools conflicts in the browser panel.
