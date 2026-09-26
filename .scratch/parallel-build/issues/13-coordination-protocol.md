# How do the coordinator and workers own, integrate and verify work?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: [02](02-workflow-harness.md), [03](03-e2e-isolation.md), [05](05-hot-file-seams.md), [12](12-worker-capacity.md), [18](18-test-policy.md)

## Question

What is the protocol for claiming a slice, owning files, running focused versus full E2E, integrating (rebase or merge, and when), handling a red full suite, recording evidence in progress.md, and retiring worktrees?

## Comments

- 2026-09-27 — Resolved: The coordinator is a fresh Claude session started in `~/work/lux-ade`, working from the handoff; the Codex build agent stays paused. A serial foundation phase by the coordinator alone comes first: hot-file splits, the Schemars scaffold, the operation-tier rule, the receipt module and worker bootstrap. Then up to 10 parallel workers (user, 2026-09-27; no per-round approval needed, cost reported after each round), each owning one domain's modules. The coordinator alone edits shared files: central contract enums, migration numbering, AGENTS.md, progress.md, decisions.md and THIRD-PARTY-NOTICES.md. Each slice writes `.scratch/ade-v1/evidence/<slice>.md` with its time log and `References:` block; the coordinator folds summaries into progress.md. Workers run static checks and in-process tests. One independent read-only review agent checks each slice. The coordinator merges one worker at a time (rebase, then `--no-ff`), runs the full static checks and build, sends red results back, and retires trees with `wt remove`. A worker's first step is to fast-forward to the build branch, run `pnpm install`, and clone `.ade/native`, `.ade/vendor` and `.ade/tools` from the main checkout.
