# What stops two E2E suites running concurrently on one Mac?

Status: closed
Type: wayfinder ticket (research, AFK)
Label: wayfinder:research
Map: [Parallel build](../README.md)
Assignee: claude (research subagent, 2026-09-27)
Blocked by: none

## Question

Which shared resources in the current E2E and build setup would collide if two worktrees ran `pnpm check` at the same time?

Inventory from the code: fixed ports, socket paths, profile and user-data directories, `ADE_*` environment variables, the Cargo `target/` directory, Electron single-instance locks, launchd or background daemons, `~/Library` paths, and the packaged-app install location. Record the current Playwright `workers` and shard settings and full-suite timings from `.scratch/ade-v1/progress.md`. For each collision, give the smallest change that isolates it.

## Comments

- 2026-09-27 (claude, research): findings in [../research/03-e2e-isolation.md](../research/03-e2e-isolation.md).
  No hard collision: every E2E derives its sockets and directories from `mkdtemp`, nothing takes an Electron single-instance lock or uses launchd, and `target/` stays per worktree. Never share `CARGO_TARGET_DIR`.
  Small fixes: give `desktop-smoke.spec.ts` its own `ADE_PROFILES_HOME` (today it opens the real `~/Library/.../profiles-v2`); strip inherited `ADE_*` variables in `playwright.config.ts`; clone `.ade/native`, `.ade/vendor` and `.ade/tools` into each new worktree.
  Open risk: CPU and memory load with 2+ suites on 10 cores (workers=1, 30 s timeout, about 6 min per serial run). The cost is about 3–5 GB of disk per worktree.
