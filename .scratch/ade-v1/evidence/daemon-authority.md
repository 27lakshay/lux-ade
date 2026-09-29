# Daemon authority: whole-effort acceptance

Status: done, with one acceptance item not comparable (memory)
Map: [daemon authority](../../daemon-authority/README.md), closed by
[ticket 08](../../daemon-authority/issues/08-integration-audit.md). Written 2026-09-29 on `main`
at `088b6c3`.

## Not settled

- **Memory can't be compared with the old 411 MB figure.** That figure came from a production
  build running the mock-layout benchmark (`bench4.mjs`, 4 chats and 6 terminals per workspace),
  whose idle floor was about 216 MB. Today's run uses real daemon terminals and no chats.
  - Production build, today: 571 MB idle, 729 MB under load, so load adds about 158 MB. The old
    run added about 195 MB.
  - The idle floor is much higher. Electron main holds 199 MB and a Node utility process holds
    104 MB. Main bundles the generated contract validators
    (`packages/contracts/dist/generated/validators.js`, 5.8 MB of source).
  - Carried to [ticket 11](../../daemon-authority/issues/11-electron-memory-floor.md).
- **The desktop's send, claim and `show_in` paths have no Electron E2E.** Renderer tests and
  typecheck cover them. The dev app started, claimed its window and ran the benchmark on the merged
  build without errors.

## Acceptance

| Item from the map | Result |
|---|---|
| A protocol E2E drives a window through the CLI alone | `e2e/protocol/acceptance/cli-window.spec.ts` passes: worktree, window, split, terminal tab, busy refusal (exit 22), forced close, one pane left |
| The desktop shows the CLI run without a restart | The benchmark builds every split and terminal tab through the CLI; the running desktop drew them (3 terminal canvases per workspace). A pane closed with `ade pane close` left the desktop at once |
| The desktop's gestures appear in `ade layout get` | Clicking Split right in the desktop gave `row(pane-main, pane-…)` in `ade layout get` |
| `apps/desktop` holds no durable state beyond the allowed copies | Ticket 10 and the audit fix pass: main forwards; appearance lives only in the daemon's settings (`7e5122c`); journals live in `@ade/client/journals` and own the draft owner ID |
| Benchmark holds 60 fps on workspace switch | Met in dev and production builds (table below) |
| Memory within 10% of the last measurement | Not comparable; see above |

## Benchmark

`realbench.mjs` in the session scratchpad: 4 workspaces × 6 live daemon terminals, each printing
`seq 1 60` every 100 ms. Workspace switches are real clicks in the navigator. Production build,
unpackaged, on the merged daemon and runtime:

| Scenario | Frames | Avg ms | p95 ms | Worst ms | Over 20 ms | Longest task |
|---|---|---|---|---|---|---|
| Idle, 3 terminals shown, all 24 streaming | 198 | 16.7 | 18.6 | 18.8 | 0 | 0 |
| Switch workspace every 400 ms (×8) | 213 | 16.7 | 18.3 | 18.6 | 0 | 0 |
| Switch workspace every 100 ms (×12) | 94 | 16.7 | 18.4 | 18.6 | 0 | 0 |

The dev build gave the same frame times (853 MB, with React Scan and React Grab loaded).

## Gates on `main`

| Gate | Result |
|---|---|
| `pnpm check:static` (tracked files) at `cff7c54` | passed |
| Full `pnpm test:e2e:protocol`, 8 workers, at `cff7c54` | 976 passed, 15 skipped, 0 failed, 5.8 minutes |
| `conversations2/draft-history.spec.ts` after `088b6c3` | 20 of 20 passed (`--repeat-each 10`) |

## Audit fix pass

- Desktop and docs half: `61abe7d` (docs), `7e5122c` (one appearance copy), `95b96a8` (main's
  draft, answer and terminal-ownership checks left to the daemon).
- Daemon and SDK half: [ticket-08-fixes.md](ticket-08-fixes.md), 18 commits ending `cff7c54`.
- Spec race: `088b6c3` waits for the turn's reply before the crash in the draft-history spec.

## Left for later

- Ticket 09: browser tab records, planned and deferred.
- The browser-only D19 items (`browser.ts` session migration, `browser-reconcile.ts` receipt
  handling) and E2E for the uncovered browser operations.
- CLI `workspace create-worktree --wait` still polls; the CLI has no feed client.
- The worktree hook payload and orchestration still name `repository_id`.
