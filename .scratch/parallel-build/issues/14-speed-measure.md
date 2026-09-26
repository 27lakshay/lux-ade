# How is delivery speed measured?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: none

## Question

What counts as progress (fully accepted feature IDs, closed R-requirements, accepted slices), what is today's baseline, and how does each slice record the time it spent on implementation, review, checks and integration so the trial run can be judged?

## Comments

- 2026-09-27 — Resolved: The main measure is fully accepted feature IDs plus R-requirements per week, with the baseline taken at `5f89455`. Every slice logs its minutes for implementation, review, checks and integration.
