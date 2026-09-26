# Which Workflow setup runs a coordinator and workers in worktrunk worktrees?

Status: closed
Type: wayfinder ticket (research, AFK)
Label: wayfinder:research
Map: [Parallel build](../README.md)
Assignee: claude (research subagent, 2026-09-27)
Blocked by: none

## Question

How can a Claude Workflow run the ADE build as a coordinator plus workers, given that worktrunk owns worktrees and machine rules forbid plain `git worktree`?

Surface these facts: whether Workflow's `isolation: worktree` uses `git worktree` (and so conflicts with `~/dotfiles/agents/machine/worktrees.md`); how a workflow agent can instead run inside a `wt new` tree and have `wt remove` retire it; how agent failures, long E2E runs and resumption (`resumeFromRunId`) behave; per-agent token and time cost for a slice-sized task; and how the coordinator hands integration and full checks to itself. Read the workflow-authoring skill and worktrunk's config.

## Comments

- 2026-09-27 — Research: [02-workflow-harness](../research/02-workflow-harness.md). Keep the coordinator as the main session in the main checkout. Each Workflow run is 2 isolated workers that return schema results. Worktree isolation goes through the WorktreeCreate hook to `wt switch`, so workers get worktrunk trees, but the trees start from `main`. Workers must `git merge --ff-only codex/architecture-proposal` and reinstall deps, or the hook later passes `--base @`. E2E exceeds the 10-minute Bash cap, so workers run it in the background and wait with Monitor. The coordinator merges locally, runs `pnpm check`, then runs `wt remove` on each tree. Worktree-isolated sessions cannot write the main checkout's `.scratch/`, so tracker edits happen on each branch and conflict at merge (input to ticket 13).
