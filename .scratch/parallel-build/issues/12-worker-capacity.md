# How many workers can this Mac run?

Status: closed
Type: wayfinder ticket (task, AFK)
Label: wayfinder:task
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: [01](01-pause-build-agent.md), [03](03-e2e-isolation.md)

## Question

With isolation from ticket 03 applied experimentally, how do total wall time, peak memory and failure rate change when 1, 2 and 3 worktrees run build plus focused E2E at the same time?

Measure on this Mac (10 CPUs, 24 GiB) without touching the user's running ADE Prototype processes. Record the numbers, and whether a shared sccache or Cargo target changes them. Work in throwaway `wt` trees and retire them afterwards.

## Comments

- 2026-09-27 — Resolved: Not measured; the user decided. Plan for 5 worker worktrees plus the coordinator. Without E2E runs the load per worker is builds and in-process tests only. Expect about 5 × 3–5 GB of `target/` against 124 GiB free, and CPU contention during simultaneous Rust builds.
