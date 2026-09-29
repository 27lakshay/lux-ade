# Handoff — 2026-09-29

The daemon authority effort is closed and everything is on `main` at the commit that adds this
file, pushed to `origin/main`. No sub-agents or worktrees are running. The dev app runs from the main
checkout on a fresh dev profile (schema 22).

Read first: `AGENTS.md`, `apps/desktop/AGENTS.md`, `CONTEXT.md`, then this map
([README.md](README.md)) and its evidence
([daemon-authority.md](../ade-v1/evidence/daemon-authority.md)).

## What is open

| Item | Where | Blocked on |
|---|---|---|
| Electron's idle memory floor (571 MB idle, production build) | [ticket 11](issues/11-electron-memory-floor.md) | Nothing. Suggested next. |
| Browser tab records, planned in full | [ticket 09](issues/09-browser-tab-records.md) | **The user.** They want to plan the browser work with you before any build. Do not start it. |
| Browser-only D19 leftovers: the session migration in `apps/desktop/src/main/browser.ts`, receipt handling in `browser-reconcile.ts`, protocol E2E for uncovered browser operations | Goes with ticket 09 | The same planning. |
| Two decisions: window claims have no client ownership; the desktop refuses a prompt while the daemon is down while the CLI queues it | "Not decided yet" in [README.md](README.md) | **The user.** Present options with costs; do not build. |
| What the desktop E2E cannot cover until the composer and transcript exist | "Not covered yet" in `e2e/desktop/README.md` | The conversation surface being built. |

## Known flakes (under load only)

- `e2e/protocol/orchestration/delegation.spec.ts:370` failed once in a full run at 8 workers;
  8 of 8 alone.
- `e2e/protocol/profiles/keybindings.spec.ts` failed twice in one agent's targeted runs; 10 of 10
  on `main`.

Neither has been investigated. If one fails again, fix the race in the spec (see `088b6c3` for
the pattern) rather than retrying.

## Standing decisions from the user

- **D19: no backwards compatibility before launch.** No aliases, deprecated fields, migrations of
  old data or old-format restores. Change in place. The store has one squashed schema; a schema
  bump means resetting dev profiles (move `.ade/dev-profiles-v2` aside, restart the dev app).
- Flat model, one owner per record, typed links. The daemon owns every durable record, rule and
  multi-step operation; the SDK owns client reliability (journals); the desktop only presents.
- Browser tabs belong to a workspace; a tab opened with no desktop running is a `not_loaded`
  record.

## How the user wants work done

- Work on `main`; commit each finished step with a focused message and report its hash. Never
  push, open a PR or merge elsewhere without being told.
- Sub-agents are approved; a Workflow or swarm needs the user's yes first. Give each sub-agent a
  worktree (`isolation: worktree`). Tell it: rebase onto `main` **once**, gate HEAD **once**, do
  not rebase again when `main` moves, wait for long steps in one blocking call, send one report.
  Remove its worktree with `wt remove <branch>` after merging.
- Plain-language replies: outcome first, uncertain and skipped items before what went well.
- Do not restyle `components/ui` kit components.

## Tools and gotchas

- **Gate.** `pnpm check:static`. If an untracked file trips its oxfmt step, run
  `node .scratch/daemon-authority/tools/check-static-tracked.mjs`, which checks only tracked files
  and runs every other step. Exit code 0 means passed.
- **Protocol E2E.** `pnpm test:e2e:protocol` builds then runs (~6–8 min). Use
  `ADE_E2E_WORKERS=8` when it runs alone, 4 when another agent runs E2E too.
- **Desktop E2E.** `pnpm test:e2e:desktop` (builds) or `test:e2e:desktop:only`. 7 specs.
- **Dev app.** Started with `wt dev pnpm dev` from the main checkout (it runs detached; log at
  `~/.local/state/dotfiles/wt-dev/Users-lakshyakumar-work-lux-ade.log`). DevTools on port 9333.
  The daemon and runtime outlive the app: after a Rust change, stop the app, then
  `pkill -TERM -f "^/Users/lakshyakumar/work/lux-ade/target/debug/ade-(daemon|runtime)"`, then
  start again — otherwise the app reconnects to the old binaries. Restarting the runtime ends the
  dev profile's shells.
- **Benchmark.** `node .scratch/daemon-authority/tools/realbench.mjs <daemon socket>` with the
  app running (`PAGE_PREFIX=ade://app` for a production build: `pnpm --filter @ade/desktop build`,
  then `electron .` in `apps/desktop` with `ADE_DAEMON_BIN` and `ADE_PROFILES_HOME` set as in
  `scripts/dev-desktop.mjs`). Find the socket with `lsof -U -a -p <daemon pid>`. It uses
  `driver.mjs` beside it. It makes 4 workspaces × 6 streaming terminals and removes them after.
- **Effect commands replay.** Reusing an `--operation-id` returns the first result (e.g. a closed
  terminal). Give every run fresh IDs.
- **CLI.** The global `--operation-id` goes before or after the command; `conversation send`,
  `queue add` and `attachment import` keep `--request-id`.
- zsh: `status` and `path` are reserved names; there is no `timeout` command.
